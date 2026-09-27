package redisx

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

var redisLog = logger.New("cao:redis")

const maxIdleConnectionAge = 5 * time.Minute

type Client struct {
	address       string
	username      string
	password      string
	database      int
	tlsConfig     *tls.Config
	timeout       time.Duration
	pool          chan *redisConnection
	singleSession bool
	sessionPermit chan struct{}
	sessionErr    error
}

type redisConnection struct {
	connection net.Conn
	reader     *bufio.Reader
	writer     *bufio.Writer
	lastUsed   time.Time
}

type redisResponseError struct {
	message string
}

type Options struct {
	AllowPrivatePlaintext bool
	SingleSession         bool
	ForceTLS              bool
	DisableTLS            bool
	TLSServerName         string
	TLSCACertificatePEM   string
}

func (c *Client) SingleSession() bool {
	return c.singleSession
}

func (err redisResponseError) Error() string {
	return err.message
}

func New(rawURL string) (*Client, error) {
	return NewWithOptions(rawURL, Options{})
}

func NewWithOptions(rawURL string, options Options) (*Client, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, errors.New("invalid Redis URL")
	}
	if parsed.Scheme != "redis" && parsed.Scheme != "rediss" {
		return nil, errors.New("redis URL must use redis:// or rediss://")
	}
	if options.ForceTLS && options.DisableTLS {
		return nil, errors.New("redis TLS cannot be both required and disabled")
	}
	if options.DisableTLS && parsed.Scheme == "rediss" {
		return nil, errors.New("redis TLS is disabled but URL uses rediss://")
	}
	if parsed.Hostname() == "" {
		return nil, errors.New("redis URL must include a host")
	}
	hostname := parsed.Hostname()
	useTLS := parsed.Scheme == "rediss" || options.ForceTLS
	if !useTLS && parsed.Scheme == "redis" && !isLoopbackHost(hostname) &&
		(!options.AllowPrivatePlaintext || !isPrivateRedisHost(hostname)) {
		return nil, errors.New("plaintext redis URL must use localhost or an explicitly allowed private host")
	}
	dialHostname := hostname
	if parsed.Scheme == "redis" && strings.EqualFold(hostname, "localhost") {
		dialHostname = "127.0.0.1"
	}
	port := parsed.Port()
	if port == "" {
		port = "6379"
	}
	database := 0
	if path := strings.TrimPrefix(parsed.Path, "/"); path != "" {
		database, err = strconv.Atoi(path)
		if err != nil || database < 0 {
			return nil, errors.New("redis URL database must be a non-negative integer")
		}
	}
	password, _ := parsed.User.Password()
	username := parsed.User.Username()
	var tlsConfig *tls.Config
	if useTLS {
		serverName := strings.TrimSpace(options.TLSServerName)
		if serverName == "" {
			serverName = hostname
		}
		tlsConfig = &tls.Config{
			MinVersion: tls.VersionTLS12,
			ServerName: serverName,
		}
		if certificate := strings.TrimSpace(options.TLSCACertificatePEM); certificate != "" {
			roots, err := x509.SystemCertPool()
			if err != nil {
				return nil, errors.New("load system Redis TLS certificate pool")
			}
			if !roots.AppendCertsFromPEM([]byte(certificate)) {
				return nil, errors.New("redis TLS CA certificate is invalid")
			}
			tlsConfig.RootCAs = roots
		}
	}
	poolSize := 8
	var sessionPermit chan struct{}
	if options.SingleSession {
		poolSize = 1
		sessionPermit = make(chan struct{}, 1)
		sessionPermit <- struct{}{}
	}
	return &Client{
		address:       net.JoinHostPort(dialHostname, port),
		username:      username,
		password:      password,
		database:      database,
		tlsConfig:     tlsConfig,
		timeout:       10 * time.Second,
		pool:          make(chan *redisConnection, poolSize),
		singleSession: options.SingleSession,
		sessionPermit: sessionPermit,
	}, nil
}

func isPrivateRedisHost(hostname string) bool {
	hostname = strings.ToLower(strings.TrimSuffix(hostname, "."))
	if strings.HasSuffix(hostname, ".railway.internal") {
		return true
	}
	if strings.Contains(hostname, ".") {
		ip := net.ParseIP(hostname)
		return ip != nil && (ip.IsPrivate() || ip.IsLoopback())
	}
	if ip := net.ParseIP(hostname); ip != nil {
		return ip.IsPrivate() || ip.IsLoopback()
	}
	return hostname != ""
}

func isLoopbackHost(hostname string) bool {
	if strings.EqualFold(hostname, "localhost") {
		return true
	}
	ip := net.ParseIP(hostname)
	return ip != nil && ip.IsLoopback()
}

func (c *Client) Do(ctx context.Context, args ...string) (any, error) {
	if len(args) > 0 {
		redisLog.Printf("executing command=%s arguments=%d", args[0], len(args)-1)
	}
	attempts := 1
	if !c.singleSession && len(args) > 0 && retryableCommand(args[0]) {
		attempts = 2
	}
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		connection, reused, err := c.acquire(ctx)
		if err != nil {
			return nil, err
		}
		if err := c.setDeadline(ctx, connection.connection); err != nil {
			c.release(connection, false)
			lastErr = err
			continue
		}
		if err := writeCommand(connection.writer, args...); err != nil {
			c.release(connection, false)
			lastErr = err
			continue
		}
		if err := connection.writer.Flush(); err != nil {
			c.release(connection, false)
			lastErr = err
			continue
		}
		value, err := readRESP(connection.reader)
		var responseErr redisResponseError
		isResponseErr := errors.As(err, &responseErr)
		reusable := err == nil || (c.singleSession && isResponseErr)
		c.release(connection, reusable)
		if err == nil {
			return value, nil
		}
		if isResponseErr {
			return nil, err
		}
		lastErr = err
		if !reused {
			break
		}
	}
	return nil, lastErr
}

func (c *Client) DoMany(ctx context.Context, commands [][]string) ([]any, error) {
	redisLog.Printf("executing command batch size=%d", len(commands))
	connection, _, err := c.acquire(ctx)
	if err != nil {
		return nil, err
	}
	reusable := false
	defer func() {
		c.release(connection, reusable)
	}()
	if err := c.setDeadline(ctx, connection.connection); err != nil {
		return nil, err
	}
	for _, command := range commands {
		if err := writeCommand(connection.writer, command...); err != nil {
			return nil, err
		}
	}
	if err := connection.writer.Flush(); err != nil {
		return nil, err
	}
	results := make([]any, len(commands))
	var responseErr error
	for index := range commands {
		results[index], err = readRESP(connection.reader)
		if err != nil {
			var redisErr redisResponseError
			if errors.As(err, &redisErr) {
				if responseErr == nil {
					responseErr = err
				}
				continue
			}
			return nil, err
		}
	}
	reusable = true
	if responseErr != nil {
		return nil, responseErr
	}
	return results, nil
}

func (c *Client) acquire(ctx context.Context) (*redisConnection, bool, error) {
	if c.singleSession {
		select {
		case <-ctx.Done():
			return nil, false, ctx.Err()
		case <-c.sessionPermit:
		}
		if err := ctx.Err(); err != nil {
			c.sessionPermit <- struct{}{}
			return nil, false, err
		}
		if c.sessionErr != nil {
			c.sessionPermit <- struct{}{}
			return nil, false, c.sessionErr
		}
	}
	select {
	case connection := <-c.pool:
		if !c.singleSession && time.Since(connection.lastUsed) > maxIdleConnectionAge {
			_ = connection.connection.Close()
			fresh, err := c.connect(ctx)
			if err != nil {
				c.poisonSession(err)
				c.releaseSessionPermit()
			}
			return fresh, false, err
		}
		return connection, true, nil
	default:
		connection, err := c.connect(ctx)
		if err != nil {
			c.poisonSession(err)
			c.releaseSessionPermit()
		}
		return connection, false, err
	}
}

func (c *Client) release(connection *redisConnection, reusable bool) {
	if c.singleSession {
		defer func() {
			c.sessionPermit <- struct{}{}
		}()
	}
	if connection == nil {
		return
	}
	if !reusable {
		_ = connection.connection.Close()
		c.poisonSession(errors.New("single-session Redis connection was lost"))
		return
	}
	_ = connection.connection.SetDeadline(time.Time{})
	connection.lastUsed = time.Now()
	select {
	case c.pool <- connection:
	default:
		_ = connection.connection.Close()
	}
}

func (c *Client) poisonSession(err error) {
	if c.singleSession && c.sessionErr == nil {
		c.sessionErr = err
	}
}

func (c *Client) releaseSessionPermit() {
	if c.singleSession {
		c.sessionPermit <- struct{}{}
	}
}

func (c *Client) setDeadline(ctx context.Context, connection net.Conn) error {
	deadline := time.Now().Add(c.timeout)
	if value, ok := ctx.Deadline(); ok && value.Before(deadline) {
		deadline = value
	}
	return connection.SetDeadline(deadline)
}

func (c *Client) connect(ctx context.Context) (*redisConnection, error) {
	redisLog.Printf("opening connection tls=%t", c.tlsConfig != nil)
	dialer := net.Dialer{Timeout: c.timeout}
	var connection net.Conn
	var err error
	if c.tlsConfig != nil {
		tlsDialer := tls.Dialer{
			NetDialer: &dialer,
			Config:    c.tlsConfig.Clone(),
		}
		connection, err = tlsDialer.DialContext(ctx, "tcp", c.address)
	} else {
		connection, err = dialer.DialContext(ctx, "tcp", c.address)
	}
	if err != nil {
		redisLog.Printf("connection failed")
		return nil, fmt.Errorf("connect to Redis: %w", err)
	}
	if err := c.setDeadline(ctx, connection); err != nil {
		_ = connection.Close()
		return nil, err
	}
	reader := bufio.NewReader(connection)
	writer := bufio.NewWriter(connection)
	if c.password != "" {
		authentication := []string{"AUTH", c.password}
		if c.username != "" {
			authentication = []string{"AUTH", c.username, c.password}
		}
		if err := writeCommand(writer, authentication...); err != nil {
			_ = connection.Close()
			return nil, err
		}
		if err := writer.Flush(); err != nil {
			_ = connection.Close()
			return nil, err
		}
		if _, err := readRESP(reader); err != nil {
			_ = connection.Close()
			return nil, errors.New("redis authentication failed")
		}
	}
	if c.database != 0 {
		if err := writeCommand(writer, "SELECT", strconv.Itoa(c.database)); err != nil {
			_ = connection.Close()
			return nil, err
		}
		if err := writer.Flush(); err != nil {
			_ = connection.Close()
			return nil, err
		}
		if _, err := readRESP(reader); err != nil {
			_ = connection.Close()
			return nil, err
		}
	}
	return &redisConnection{connection: connection, reader: reader, writer: writer}, nil
}

func retryableCommand(command string) bool {
	switch strings.ToUpper(command) {
	case "PING", "GET", "HGET", "HGETALL", "HMGET", "SMEMBERS":
		return true
	default:
		return false
	}
}

func writeCommand(writer *bufio.Writer, args ...string) error {
	if _, err := fmt.Fprintf(writer, "*%d\r\n", len(args)); err != nil {
		return err
	}
	for _, argument := range args {
		if _, err := fmt.Fprintf(writer, "$%d\r\n%s\r\n", len(argument), argument); err != nil {
			return err
		}
	}
	return nil
}

func readRESP(reader *bufio.Reader) (any, error) {
	prefix, err := reader.ReadByte()
	if err != nil {
		return nil, err
	}
	line := func() (string, error) {
		value, err := reader.ReadString('\n')
		return strings.TrimSuffix(strings.TrimSuffix(value, "\n"), "\r"), err
	}
	switch prefix {
	case '+':
		return line()
	case '-':
		message, lineErr := line()
		if lineErr != nil {
			return nil, lineErr
		}
		return nil, redisResponseError{message: message}
	case ':':
		value, lineErr := line()
		if lineErr != nil {
			return nil, lineErr
		}
		return strconv.ParseInt(value, 10, 64)
	case '$':
		value, lineErr := line()
		if lineErr != nil {
			return nil, lineErr
		}
		length, parseErr := strconv.Atoi(value)
		if parseErr != nil {
			return nil, parseErr
		}
		if length == -1 {
			return nil, nil
		}
		data := make([]byte, length+2)
		if _, err := io.ReadFull(reader, data); err != nil {
			return nil, err
		}
		return string(data[:length]), nil
	case '*':
		value, lineErr := line()
		if lineErr != nil {
			return nil, lineErr
		}
		length, parseErr := strconv.Atoi(value)
		if parseErr != nil {
			return nil, parseErr
		}
		if length == -1 {
			return nil, nil
		}
		values := make([]any, length)
		for i := range values {
			values[i], err = readRESP(reader)
			if err != nil {
				return nil, err
			}
		}
		return values, nil
	default:
		return nil, fmt.Errorf("unsupported Redis response prefix %q", prefix)
	}
}

func Strings(value any) ([]string, error) {
	items, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("expected Redis array, got %T", value)
	}
	output := make([]string, len(items))
	for i, item := range items {
		if item == nil {
			continue
		}
		output[i] = fmt.Sprint(item)
	}
	return output, nil
}

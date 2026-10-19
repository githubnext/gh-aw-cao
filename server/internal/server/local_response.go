package server

import (
	"bufio"
	"net"
	"net/http"
)

type localResponse struct {
	http.ResponseWriter
	status int
}

func (w *localResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
		w.ResponseWriter.WriteHeader(status)
	}
}

func (w *localResponse) Write(content []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(content)
}

func (w *localResponse) Flush() {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	if err := http.NewResponseController(w.ResponseWriter).Flush(); err != nil {
		serverLog.Printf("local response flush failed")
	}
}

func (w *localResponse) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	connection, buffer, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err == nil {
		w.status = http.StatusSwitchingProtocols
	}
	return connection, buffer, err
}

package hostedcli

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func outputFixture(t *testing.T) (*outputSink, *fakeQueue, int64) {
	t.Helper()
	queue := newFakeQueue()
	id := enqueue(t, queue, "gh aw upgrade --repo octo/app --create-pull-request", "octo/app", "mona")
	if _, err := queue.Claim(t.Context(), operational.CLICommandLease{}); err != nil {
		t.Fatal(err)
	}
	return newOutputSink(t.Context(), queue, operational.CLICommandLease{}, id), queue, id
}

func assertOutput(t *testing.T, queue *fakeQueue, id int64, want string) {
	t.Helper()
	if got := queue.text(id); got != want {
		t.Fatalf("unexpected output: got %d bytes, want %d bytes", len(got), len(want))
	}
	for _, chunk := range queue.output[id] {
		if len(chunk.Data) > maxBufferedLine {
			t.Fatalf("chunk too large: %d bytes", len(chunk.Data))
		}
		if err := operational.ValidateCLICommandText(chunk.Data); err != nil {
			t.Fatal("output chunk is not storable")
		}
	}
}

func TestOutputSinkBufferBoundaries(t *testing.T) {
	for _, size := range []int{maxBufferedLine - 1, maxBufferedLine, maxBufferedLine + 1, 4 * maxBufferedLine} {
		for _, newline := range []bool{false, true} {
			t.Run(fmt.Sprintf("%d/newline=%t", size, newline), func(t *testing.T) {
				sink, queue, id := outputFixture(t)
				text := strings.Repeat(".", size)
				if newline {
					text += "\n"
				}
				sink.write("stdout", []byte(text))
				sink.close()
				assertOutput(t, queue, id, text)
			})
		}
	}
}

func TestOutputSinkUTF8AcrossWritesAndFrames(t *testing.T) {
	for _, runeText := range []string{"é", "€", "🙂"} {
		for split := 1; split < len(runeText); split++ {
			t.Run(fmt.Sprintf("%d/%d", len(runeText), split), func(t *testing.T) {
				sink, queue, id := outputFixture(t)
				prefix := strings.Repeat(".", maxBufferedLine-split)
				sink.write("stdout", []byte(prefix+runeText[:split]))
				for _, chunk := range queue.output[id] {
					if !utf8.ValidString(chunk.Data) || strings.ContainsRune(chunk.Data, utf8.RuneError) {
						t.Fatal("an incomplete rune was published")
					}
				}
				sink.write("stdout", []byte(runeText[split:]+"\n"))
				sink.close()
				assertOutput(t, queue, id, prefix+runeText+"\n")
			})
		}
	}
}

func TestOutputSinkRegisteredSecretsAcrossBoundaries(t *testing.T) {
	for _, secret := range []string{
		"ghs_" + strings.Repeat("b", 36),
		"synthetic-exact-credential",
		"synthetic\nmultiline-credential",
	} {
		for split := 1; split < len(secret); split++ {
			t.Run(fmt.Sprintf("%d/%d", len(secret), split), func(t *testing.T) {
				sink, queue, id := outputFixture(t)
				sink.secret(secret)
				prefix := strings.Repeat(".", maxBufferedLine-split)
				sink.write("stdout", []byte(prefix+secret[:split]))
				if got := queue.text(id); strings.Contains(got, secret[:split]) {
					t.Fatal("a pending credential prefix was published")
				}
				sink.write("stdout", []byte(secret[split:]+"\n"))
				sink.close()
				assertOutput(t, queue, id, prefix+"[REDACTED]\n")
			})
		}
	}
}

func TestOutputSinkRegisteredSecretRetentionAndOverlap(t *testing.T) {
	for _, secrets := range [][]string{
		{"synthetic", "synthetic-credential"},
		{"synthetic-credential", "synthetic"},
		{"synthetic-" + strings.Repeat("x", 3*maxBufferedLine)},
	} {
		sink, queue, id := outputFixture(t)
		longest := ""
		for _, secret := range secrets {
			sink.secret(secret)
			if len(secret) > len(longest) {
				longest = secret
			}
		}
		for i := range len(longest) {
			sink.write("stdout", []byte(longest[i:i+1]))
			if len(sink.streams["stdout"].known) > len(longest) {
				t.Fatal("known-credential retention exceeded the credential length")
			}
		}
		sink.close()
		assertOutput(t, queue, id, "[REDACTED]")
	}
}

func TestOutputSinkMasksUnfinishedRegisteredSecretAtClose(t *testing.T) {
	sink, queue, id := outputFixture(t)
	sink.secret("synthetic-credential")
	sink.write("stdout", []byte("sy"))
	sink.write("stderr", []byte("nthetic-credential"))
	sink.close()
	assertOutput(t, queue, id, "[REDACTED]nthetic-credential")
}

func TestOutputSinkRecognizedSecretsAcrossBoundaries(t *testing.T) {
	for _, secret := range []string{
		"ghs_synthetic", "GHp_synthetic", "gho_synthetic", "ghu_synthetic", "ghr_synthetic",
		"ghſ_synthetic", "toKen=synthetic", "paſſword=synthetic",
		"github_pat_synthetic", "AKIAABCDEFGHIJKLMNOP", "Bearer synthetic",
		"Bearer \n\t synthetic", "token=synthetic", "PASSWORD \n ' : \n 'synthetic",
		"secret:synthetic", "credential=synthetic", "authorization:synthetic",
		"privatekey=synthetic", "private-key=synthetic", "private_key=synthetic",
		"-----BEGIN SYNTHETIC PRIVATE KEY-----", "--synthetic-token",
	} {
		for split := 1; split < len(secret); split++ {
			t.Run(fmt.Sprintf("%s/%d", strings.Fields(secret)[0], split), func(t *testing.T) {
				sink, queue, id := outputFixture(t)
				prefix := strings.Repeat(".", maxBufferedLine-split)
				sink.write("stdout", []byte(prefix+secret[:split]))
				if got := queue.text(id); got != "" && strings.Trim(got, ".") != "" {
					t.Fatal("a pending recognized credential prefix was published")
				}
				sink.write("stdout", []byte(secret[split:]+"\n"))
				sink.close()
				assertOutput(t, queue, id, prefix+"[REDACTED]\n")
			})
		}
	}
}

func TestOutputSinkRedactionAcrossByteWrites(t *testing.T) {
	sink, queue, id := outputFixture(t)
	sink.secret("synthetic-credential")
	text := "safe\nsynthetic-credential token = 'example'\nBearer \n example\nmore\n"
	for i := range len(text) {
		sink.write("stdout", []byte(text[i:i+1]))
	}
	sink.close()
	assertOutput(t, queue, id, "safe\n[REDACTED] [REDACTED]\n[REDACTED]\nmore\n")
}

func TestOutputSinkNestedCredentialIntroducers(t *testing.T) {
	for _, text := range []string{
		"--authorization=synthetic",
		"--private-key=synthetic",
		"--Bearer synthetic",
		"--token-authorization=synthetic",
		"-----BEGIN note Bearer\nsynthetic",
		"-----BEGIN SYNTHETIC PRIVATE KEY----- Bearer\nsynthetic",
	} {
		for split := 1; split < len(text); split++ {
			sink, queue, id := outputFixture(t)
			prefix := strings.Repeat(".", maxBufferedLine-split)
			sink.write("stdout", []byte(prefix+text[:split]))
			sink.write("stdout", []byte(text[split:]+"\n"))
			sink.close()
			if strings.Contains(queue.text(id), "synthetic") {
				t.Fatalf("nested introducer leaked at split %d", split)
			}
			assertOutput(t, queue, id, operational.RedactCLICommandText(prefix+text+"\n"))
		}
	}
}

func TestOutputSinkPlainOutputAcrossByteWrites(t *testing.T) {
	sink, queue, id := outputFixture(t)
	text := "Running with a single-use token scoped to octo/app.\n" +
		"Bearers have passwords; --verbose private-key names and github links are ordinary text.\n" +
		"héllo 🙂 --flag=value\ng"
	for i := range len(text) {
		sink.write("stdout", []byte(text[i:i+1]))
	}
	sink.close()
	assertOutput(t, queue, id, text)
}

func TestOutputSinkOverlongCredentialCandidates(t *testing.T) {
	for _, parts := range [][2]string{
		{"ghs_", ""},
		{"github_pat_", ""},
		{"Bearer ", ""},
		{"Bearer", " synthetic"},
		{"token=", ""},
		{"token", "=synthetic"},
		{"-----BEGIN ", " PRIVATE KEY-----"},
		{"--", "-token"},
		{"--", "-authorization=synthetic"},
		{"-----BEGIN ", " Bearer\nsynthetic"},
	} {
		t.Run(parts[0]+parts[1], func(t *testing.T) {
			sink, queue, id := outputFixture(t)
			filler := "x"
			if parts[0] == "Bearer" || parts[0] == "token" {
				filler = " "
			}
			text := parts[0] + strings.Repeat(filler, 8*maxBufferedLine) + parts[1] + "\nafter\n"
			for i := 0; i < len(text); i += 37 {
				sink.write("stdout", []byte(text[i:min(i+37, len(text))]))
				stream := sink.streams["stdout"]
				if len(stream.candidate) > maxBufferedLine || len(stream.frame) > maxBufferedLine ||
					cap(stream.candidate) > 2*maxBufferedLine || cap(stream.frame) > 2*maxBufferedLine {
					t.Fatal("output retention exceeded its bound")
				}
			}
			sink.notice("stderr remains available\n")
			sink.close()
			assertOutput(t, queue, id, suppressedOutput+"stderr remains available\n")
		})
	}
}

func TestOutputSinkFlushAndClose(t *testing.T) {
	for _, suffix := range []string{"", "\n"} {
		sink, queue, id := outputFixture(t)
		sink.secret("synthetic-credential")
		sink.write("stdout", []byte("synthetic-"))
		sink.notice("stderr is independent\n")
		sink.write("stdout", []byte("credential"+suffix))
		sink.close()
		sink.close()
		sink.write("stdout", []byte("ignored\n"))
		assertOutput(t, queue, id, "stderr is independent\n[REDACTED]"+suffix)
		if queue.output[id][0].Stream != "stderr" || queue.output[id][1].Stream != "stdout" {
			t.Fatal("stream identity was lost")
		}
	}
}

func TestOutputSinkSanitizesBeforeKnownRedaction(t *testing.T) {
	sink, queue, id := outputFixture(t)
	sink.secret("synthetic-credential")
	sink.write("stdout", []byte("synthetic-\x00credential\n"))
	sink.write("stdout", []byte(strings.Repeat("\xff.", 2*maxBufferedLine)))
	sink.write("stdout", []byte("\xe2\x82"))
	sink.close()
	assertOutput(t, queue, id, "[REDACTED]\n"+strings.Repeat("\uFFFD.", 2*maxBufferedLine)+"\uFFFD")
}

type failingOutputQueue struct {
	operational.CLICommandQueue
	calls       int
	contextErr  error
	hasDeadline bool
}

func (q *failingOutputQueue) AppendOutput(ctx context.Context, _ operational.CLICommandLease, _ int64, _, _ string) (operational.CLICommandOutput, error) {
	q.calls++
	q.contextErr = ctx.Err()
	_, q.hasDeadline = ctx.Deadline()
	if err := ctx.Err(); err != nil {
		return operational.CLICommandOutput{}, err
	}
	return operational.CLICommandOutput{}, operational.ErrConflict
}

func TestOutputSinkStopsAfterAppendFailure(t *testing.T) {
	queue := &failingOutputQueue{}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	sink := newOutputSink(ctx, queue, operational.CLICommandLease{}, 1)
	sink.write("stdout", []byte(strings.Repeat(".\n", maxBufferedLine)))
	sink.close()
	sink.write("stdout", []byte("ignored\n"))
	if queue.calls != 1 || !sink.stopped || queue.contextErr != nil || !queue.hasDeadline {
		t.Fatal("a failed append must stop subsequent output")
	}
}

func TestOutputSinkConcurrentStreamsAndCancellation(t *testing.T) {
	sink, queue, id := outputFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	sink.ctx = ctx
	sink.secret("synthetic-credential")
	var writers sync.WaitGroup
	for _, stream := range []string{"stdout", "stderr"} {
		writers.Go(func() {
			for range 50 {
				sink.write(stream, []byte("synthetic-"))
				sink.write(stream, []byte("credential\n"))
			}
		})
	}
	cancel()
	writers.Wait()
	sink.close()
	assertOutput(t, queue, id, strings.Repeat("[REDACTED]\n", 100))
	if !errors.Is(ctx.Err(), context.Canceled) {
		t.Fatal("test context was not canceled")
	}
}

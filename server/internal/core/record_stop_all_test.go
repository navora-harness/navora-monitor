package core

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStopAllClearsPersistentResumeIntent(t *testing.T) {
	c := isolatedCore(t)
	c.rememberRecord("test")
	token, err := c.OpenSession("navora")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/record/stop-all", nil)
	request.RemoteAddr = "127.0.0.1:1234"
	request.AddCookie(&http.Cookie{Name: cookieName, Value: token})
	response := httptest.NewRecorder()
	c.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("stop all: %d %s", response.Code, response.Body.String())
	}
	if c.remembered["test"] || !c.scheduleHold["test"] {
		t.Fatal("manual stop retained resume intent or failed to hold schedule")
	}
	reopened, err := Open(c.root)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.remembered["test"] {
		t.Fatal("stopped recording resumes after restart")
	}
}

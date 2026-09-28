package core

import (
	"encoding/json"
	"sync"
)

type broker struct {
	mu      sync.Mutex
	clients map[chan []byte]struct{}
	extra   func(event string, v any)
}

func newBroker() *broker {
	return &broker{clients: map[chan []byte]struct{}{}}
}

func (b *broker) subscribe() chan []byte {
	ch := make(chan []byte, 16)
	b.mu.Lock()
	b.clients[ch] = struct{}{}
	b.mu.Unlock()
	return ch
}

func (b *broker) unsubscribe(ch chan []byte) {
	b.mu.Lock()
	delete(b.clients, ch)
	b.mu.Unlock()
}

func (b *broker) Publish(event string, v any) {
	payload, err := json.Marshal(v)
	if err != nil {
		return
	}
	msg := append([]byte("event: "+event+"\ndata: "), payload...)
	msg = append(msg, '\n', '\n')
	b.mu.Lock()
	extra := b.extra
	for ch := range b.clients {
		select {
		case ch <- msg:
		default:
			delete(b.clients, ch)
		}
	}
	b.mu.Unlock()
	if extra != nil {
		extra(event, v)
	}
}

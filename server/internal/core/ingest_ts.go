package core

// The producer controls these PIDs (see buildIngestArgs). Keep complete TS
// packets and the most recent random-access GOP; never replay a byte-window
// beginning in the middle of a packet or a dependent video frame.
const (
	tsPacketSize   = 188
	ingestVideoPID = 256
	ingestPMTPID   = 4096
	ingestGOPMax   = 8 * 1024 * 1024
)

type tsJoinCache struct {
	tail     []byte
	pat, pmt []byte
	headers  []byte
	parts    [][]byte
	size     int
	ready    bool
}

// feed returns aligned data, plus the first join point in this batch, if any.
// Returned slices are immutable, so subscribers and cache can share them.
func (j *tsJoinCache) feed(chunk []byte) (data []byte, joinAt int, headers []byte) {
	joined := append(j.tail, chunk...)
	joinAt = -1
	start := 0
	for len(joined)-start >= tsPacketSize {
		if joined[start] == 0x47 && (len(joined)-start < 2*tsPacketSize || joined[start+tsPacketSize] == 0x47) {
			break
		}
		start++
	}
	n := (len(joined) - start) / tsPacketSize * tsPacketSize
	if start > 0 {
		j.invalidate()
	}
	data = append([]byte(nil), joined[start:start+n]...)
	j.tail = append([]byte(nil), joined[start+n:]...)
	cacheStart := 0
	for i := 0; i < len(data); i += tsPacketSize {
		p := data[i : i+tsPacketSize]
		if p[0] != 0x47 || p[1]&0x80 != 0 { // corrupt/transport error
			j.invalidate()
			continue
		}
		pid := int(p[1]&0x1f)<<8 | int(p[2])
		if pid == 0 || pid == ingestPMTPID {
			// Our producer has one program with at most video and audio, so each
			// table fits one packet. Reject incomplete tables rather than replay them.
			if completeTSTable(p) {
				if pid == 0 {
					j.pat = p
				} else {
					j.pmt = p
				}
			}
		}
		adaptation := p[3] >> 4 & 3
		key := pid == ingestVideoPID && p[1]&0x40 != 0 && adaptation == 3 && p[4] >= 1 && p[4] <= 182 && p[5]&0x40 != 0
		if key && len(j.pat) != 0 && len(j.pmt) != 0 {
			j.headers = append(append([]byte(nil), j.pat...), j.pmt...)
			j.parts, j.size, j.ready = nil, 0, true
			cacheStart = i
			if joinAt < 0 {
				joinAt, headers = i, j.headers
			}
		}
	}
	if j.ready && len(data) > cacheStart {
		part := data[cacheStart:]
		if j.size+len(part) > ingestGOPMax {
			j.invalidate()
		} else {
			j.parts = append(j.parts, part)
			j.size += len(part)
		}
	}
	return
}

func completeTSTable(p []byte) bool {
	if p[1]&0x40 == 0 {
		return false
	}
	offset := 4
	switch p[3] >> 4 & 3 {
	case 1:
	case 3:
		offset += 1 + int(p[4])
	default:
		return false
	}
	if offset >= len(p) {
		return false
	}
	offset += 1 + int(p[offset]) // PSI pointer field
	if offset+3 > len(p) {
		return false
	}
	length := int(p[offset+1]&0x0f)<<8 | int(p[offset+2])
	return length >= 4 && offset+3+length <= len(p)
}

func (j *tsJoinCache) invalidate() {
	j.ready = false
	j.headers, j.parts, j.size = nil, nil, 0
}

func (j *tsJoinCache) snapshot() [][]byte {
	if !j.ready {
		return nil
	}
	out := make([][]byte, 1, 1+len(j.parts))
	out[0] = j.headers
	return append(out, j.parts...)
}

import { useEffect, useRef, useState } from 'react'
import './App.css'

const API_HOST = 'localhost:8000'

type TranscriptLine = {
  start: number
  end: number
  text: string
}

type Status = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

function App() {
  const [streamerIdInput, setStreamerIdInput] = useState('dead_oryx')
  const [streamerId, setStreamerId] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [lines, setLines] = useState<TranscriptLine[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!streamerId) return

    setLines([])
    setStatus('connecting')
    const ws = new WebSocket(`ws://${API_HOST}/ws/transcripts/${streamerId}`)

    ws.onopen = () => setStatus('open')
    ws.onerror = () => setStatus('error')
    ws.onclose = () => setStatus('closed')
    ws.onmessage = (event) => {
      const line: TranscriptLine = JSON.parse(event.data)
      setLines((prev) => [...prev, line])
    }

    return () => ws.close()
  }, [streamerId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  return (
    <main className="page">
      <h1>twitch-transcript</h1>

      <form
        className="watch-form"
        onSubmit={async (e) => {
          e.preventDefault()
          const channel_url = `https://www.twitch.tv/${streamerIdInput.trim()}`
          const res = await fetch(`http://${API_HOST}/watch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel_url }),
          })
          const data = await res.json()
          setStreamerId(data.streamer_id)
        }}
      >
        <input
          value={streamerIdInput}
          onChange={(e) => setStreamerIdInput(e.target.value)}
          placeholder="streamer id"
        />
        <button type="submit">Watch</button>
      </form>

      {streamerId && (
        <>
          <p className="status">
            {streamerId} — <span className={`dot ${status}`} />
            {status}
          </p>
          <div className="transcript">
            {lines.map((line, i) => (
              <p key={i}>{line.text}</p>
            ))}
            <div ref={bottomRef} />
          </div>
        </>
      )}
    </main>
  )
}

export default App

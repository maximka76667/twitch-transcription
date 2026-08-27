from faster_whisper import WhisperModel

model = WhisperModel("small", device="cpu", compute_type="int8")
segments, info = model.transcribe("test.wav")

for seg in segments:
    print(f"[{seg.start:.2f}-{seg.end:.2f}] {seg.text}")

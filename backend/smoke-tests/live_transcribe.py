import os
import re
import shutil
import subprocess
import sys
import time

STREAMLINK = os.path.join(os.path.dirname(sys.executable), "streamlink.exe")

from faster_whisper import WhisperModel

CHANNEL_URL = "https://www.twitch.tv/dead_oryx"
CHUNK_DIR = "chunks"
CHUNK_SECONDS = 3
MAX_LAG_CHUNKS = 4  # if we fall this many chunks behind, skip ahead instead of transcribing the backlog

shutil.rmtree(CHUNK_DIR, ignore_errors=True)
os.makedirs(CHUNK_DIR, exist_ok=True)

streamlink_proc = subprocess.Popen(
    [STREAMLINK, CHANNEL_URL, "audio_only", "-O", "--twitch-low-latency"],
    stdout=subprocess.PIPE,
)

ffmpeg_proc = subprocess.Popen(
    [
        "ffmpeg",
        "-y",
        "-i",
        "pipe:0",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "segment",
        "-segment_time",
        str(CHUNK_SECONDS),
        "-reset_timestamps",
        "1",
        os.path.join(CHUNK_DIR, "chunk_%03d.wav"),
    ],
    stdin=streamlink_proc.stdout,
    stderr=subprocess.DEVNULL,
)
streamlink_proc.stdout.close()

model = WhisperModel("small", device="cpu", compute_type="int8")

chunk_re = re.compile(r"chunk_(\d+)\.wav")
next_index = 0
elapsed = 0.0

print("Listening... Ctrl+C to stop.")

try:
    while True:
        files = sorted(os.listdir(CHUNK_DIR))
        indices = sorted(int(m.group(1)) for f in files if (m := chunk_re.match(f)))

        if indices:
            newest = indices[-1]
            lag = newest - next_index
            if lag > MAX_LAG_CHUNKS:
                skip_to = newest - MAX_LAG_CHUNKS
                skipped = skip_to - next_index
                for i in range(next_index, skip_to):
                    stale_path = os.path.join(CHUNK_DIR, f"chunk_{i:03d}.wav")
                    if os.path.exists(stale_path):
                        os.remove(stale_path)
                elapsed += skipped * CHUNK_SECONDS
                next_index = skip_to
                print(f"[lag] falling behind, skipped {skipped} chunk(s) to catch up")

        # only transcribe a chunk once ffmpeg has moved on to the next one
        while next_index in indices and (next_index + 1) in indices:
            path = os.path.join(CHUNK_DIR, f"chunk_{next_index:03d}.wav")
            segments, _ = model.transcribe(path, language="en")
            for seg in segments:
                print(f"[{elapsed + seg.start:.2f}-{elapsed + seg.end:.2f}] {seg.text}")
            elapsed += CHUNK_SECONDS
            os.remove(path)
            next_index += 1
        time.sleep(0.5)
except KeyboardInterrupt:
    print("Stopping...")
finally:
    ffmpeg_proc.terminate()
    streamlink_proc.terminate()

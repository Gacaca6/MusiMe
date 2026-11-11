# MP3 import fixture

`import-tone.mp3` is a generated four-second, 440 Hz mono tone at 64 kbit/s,
with ID3 title `MP3 import check` and artist `MusiMe test tone`. It contains no
third-party recording. Browser checks use this genuine MP3 for import and
offline playback rather than a WAV file named with an MP3 extension.

Recreate with FFmpeg:

```sh
ffmpeg -f lavfi -i sine=frequency=440:duration=4 -c:a libmp3lame -b:a 64k -ac 1 -metadata title="MP3 import check" -metadata artist="MusiMe test tone" -id3v2_version 3 import-tone.mp3
```

The video import fixtures contain a black frame and a generated 440 Hz tone.
The silent fixture uses the same video track with the audio removed.

```sh
ffmpeg -f lavfi -i color=c=black:s=64x64:r=12:d=3 -f lavfi -i sine=frequency=440:duration=3 -map 0:v -map 1:a -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 48k -shortest video-with-audio.mp4
ffmpeg -i video-with-audio.mp4 -map 0:v -an -c:v copy video-silent.mp4
ffmpeg -i video-with-audio.mp4 -map 0 -c copy video-with-audio.mov
```

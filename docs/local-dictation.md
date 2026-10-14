# Local microphone dictation

EterX defaults to **Whisper Large v3, Q5_0**, not Turbo. Its model file is
1,081,140,203 bytes (about 1.08 GB). Quantization reduces the model size and
memory footprint; Large v3 still needs substantially more memory and CPU time
than Small. No model guarantees perfect transcripts or real-time performance
on every machine.

Settings → General → Microphone and speech provides microphone selection,
dictation language selection, and a local model manager. System default and
Auto-detect are the initial microphone and language choices. A specific device
applies to dictation and live voice chat; changes take effect next session.
Disconnected devices produce an actionable message instead of silently
switching inputs. Refresh can request microphone access to reveal device names.

The searchable catalog contains 33 compatible Whisper models and variants:
Tiny, Base, Small, Medium, Large v1/v2/v3, and Large v3 Turbo. It includes
upstream original-precision, Q5, Q8, and English-only variants where available.
Large v3 Q5_0 remains the default. Turbo is an optional choice, never an
automatic substitution. English-only models require English or Auto-detect.

Click a model's download icon to start downloading it. The row shows a spinner,
live percentage, progress bar, and Cancel action. A complete download enables
the blue **Use** button, which makes that model the default for future
dictation sessions. The selected installed model shows **Default**. Failed
downloads show an error and Retry action; cancelled downloads can be restarted.
The Downloaded filter finds installed models and downloads in progress.

The default model ships with the desktop installer. Additional models download
on demand into the application user-data directory. Downloads are
streamed to a temporary file and checked against pinned SHA-256 digests before
installation. The manager and dictation share a per-model download task, so
simultaneous requests cannot overwrite the same file. Closing Settings keeps
explicit downloads running while EterX remains open. Cancelling dictation does
not cancel an explicit Settings download. Completed models remain available
offline across app restarts. Only the selected model is loaded for inference.

Local dictation audio and transcripts stay local; no speech API key is needed.
Live voice conversations continue to use their configured realtime provider.
Main chat, proxy chat, and workspace side-chat dictation use the same local
engine, model choice, and language preference.
The microphone shows preparation/download progress, then “Listening…” after
capture starts. Turning it off finishes buffered transcription; leaving the
chat or sending the message discards pending results for that draft.
If processing falls more than two minutes behind, capture pauses and buffered
audio finishes transcribing instead of silently dropping words.

## Packaging

`scripts/prepare-whisper-runtime.mjs` prepares the pinned whisper.cpp b4938
runtime without invoking Git. On Windows x64 it downloads the official CPU
runtime ZIP and verifies its pinned size and SHA-256 checksum. Normal
`npm run desktop` startup on Windows x64 does not require CMake, NMake, or a
C++ compiler. The executable and accompanying DLLs are installed together.

Windows ARM64, macOS, and Linux use native source builds. Source builds require
CMake, tar, and a C++ toolchain on the corresponding operating system:

- Windows: Visual Studio C++ build tools with the x64 and ARM64 components.
  The script explicitly selects an installed Visual Studio generator before
  passing `-A x64` or `-A ARM64`; it does not pass those flags to NMake or Ninja.
- macOS: Xcode command-line tools and CMake; separate Intel and Apple Silicon
  binaries, targeting macOS 11 or newer, with embedded Metal resources.
- Linux: GCC/G++ and CMake. Cross-compiling ARM64 on x64 also requires
  `gcc-aarch64-linux-gnu` and `g++-aarch64-linux-gnu`. Release builds use Ubuntu
  22.04, so the resulting runtime requires glibc 2.35 or newer.

The existing `desktop:build:win`, `desktop:build:mac`, and `desktop:build:linux`
commands prepare both architectures on their respective host. These are build
instructions, not a record of executed validation.

To opt into a Windows x64 source build, set
`ETERX_WHISPER_BUILD_FROM_SOURCE=1`. An explicit Visual Studio generator can
be supplied with `ETERX_WHISPER_CMAKE_GENERATOR`, for example
`Visual Studio 17 2022`. Cache manifests distinguish source builds from
prebuilt runtimes so changing this choice prepares the appropriate runtime.

Executables, native libraries, and the default model are shipped as real files
under `resources/runtime/assets/native/whisper`, outside `app.asar`. Source
builds include all x64 CPU backends, selected according to available instructions;
prebuilt Windows packages retain the backends supplied by upstream.
Windows ARM64 uses a native executable. Linux libraries use a relative loader
path, and macOS can retry on CPU if Metal initialization fails.

For older layouts, the launcher also recognizes `app.asar.unpacked`. A runtime
found only inside `app.asar` is copied with its libraries into a versioned
user-data directory before launch. An archived model is also materialized to
disk. The process is bound only to loopback and uses a random request prefix;
readiness requires the server's model-loaded health response.

Runtime manifests invalidate stale build caches when packaging changes.
Optional models and obsolete model files are excluded from installers. End
users do not need Python, FFmpeg, CMake, or a compiler to dictate.

`electron/whisper-models.json` pins model sizes and SHA-256 LFS identifiers from
the upstream model repository. `electron/whisper-languages.json` records the
language identifiers supported by the pinned whisper.cpp runtime. Both files
are included in the Electron package. The renderer receives only catalog
metadata and progress through trusted IPC; it cannot supply download URLs or
destination paths.

Upstream references:

- [whisper.cpp models](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md)
- [Model files and LFS digests](https://huggingface.co/ggerganov/whisper.cpp/tree/main)
- [Pinned whisper.cpp release](https://github.com/ggml-org/whisper.cpp/releases/tag/b4938)

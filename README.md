# Transcrptr

Transcrptr is a blazing fast, privacy-first desktop application for audio transcription powered by OpenAI's Whisper AI model running completely locally on your hardware.

![Transcrptr Screenshot](assets/screenshot.png) *(Placeholder for macOS screenshot)*

## Features
- **100% Local Processing:** Your audio files and voice data never leave your computer.
- **Hardware Accelerated:** Uses Vulkan on Windows and Metal on macOS to dramatically speed up transcription.
- **Flexible Inputs:** Record directly using any available microphone with a real-time visualizer, or transcribe existing audio files.
- **Model Choice:** Choose between Small, Medium, and Large models depending on your need for speed vs absolute accuracy.

## Download & Install
Head over to the [Releases](https://github.com/mrswedish/transcrptr/releases) page to download the latest version for your platform:

- **Windows:** Download `Transcrptr-portable.exe` and run it directly. No installation required.
- **macOS:** Download the `.dmg` or `.app` from the release assets. *(Note: macOS builds may require bypassing Gatekeeper on first launch as the app is currently unsigned).*

## Architecture
Transcrptr is built with:
- **Tauri** (Rust backend, web frontend)
- **Whisper.cpp** via `whisper-rs` for C++ optimized transcription
- **Vanilla JS + Tailwind CSS** for a snappy, gorgeous UI

## Building from source

### Prerequisites
- [Node.js](https://nodejs.org/) (v20+)
- [Rust](https://www.rust-lang.org/tools/install)
- [CMake](https://cmake.org/)

### Setup
```bash
# Clone the repository
git clone https://github.com/mrswedish/transcrptr.git
cd transcrptr

# Install frontend dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

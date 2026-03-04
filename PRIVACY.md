# Privacy Policy — Transcrptr

**Last updated:** 2026-03-04

## Overview

Transcrptr is a local, privacy-first desktop application for speech-to-text transcription. **All audio processing happens entirely on your device.** No data is ever sent to external servers.

## Data Collection

**Transcrptr does not collect, store, transmit, or share any personal data.**

Specifically:

- **Audio data** — All audio recordings and uploaded files are processed locally using on-device AI models. Audio never leaves your computer.
- **Transcription results** — All transcribed text remains on your device. Saving transcriptions to file is an explicit user action, stored only to a location you choose.
- **Settings and preferences** — Model size, language, and microphone preferences are stored locally in the application's browser storage (localStorage). These are never transmitted externally.
- **AI models** — Language models are downloaded once from [Hugging Face](https://huggingface.co/KBLab) and cached locally on your device. No user data is sent during this download.

## Network Usage

Transcrptr connects to the internet **only** for:

1. **Downloading AI models** — A one-time download of the selected speech recognition model from Hugging Face. No user data or identifiers are included in this request.

No other network connections are made. Transcrptr functions fully offline after the initial model download.

## Third-Party Services

Transcrptr does **not** integrate with any third-party analytics, advertising, tracking, or telemetry services.

## Data Storage

All application data is stored locally on your device:

- **AI models** — Stored in the application's data directory
- **User settings** — Stored in localStorage (browser storage)
- **Transcriptions** — Only saved when you explicitly export to a `.txt` file

No cloud storage or remote databases are used.

## Children's Privacy

Transcrptr does not knowingly collect any data from children or any other users. The application collects no data whatsoever.

## Changes to This Policy

If this privacy policy changes, the updated version will be published in the application's GitHub repository at [github.com/mrswedish/transcrptr](https://github.com/mrswedish/transcrptr).

## Contact

If you have questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/mrswedish/transcrptr/issues).

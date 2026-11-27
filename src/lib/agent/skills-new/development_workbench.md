---
name: development-workbench
description: Use for live app previews, development servers, native simulators, or SSH device setup.
category: coding
icon: PanelRight
requires_tool: workspace_workbench
---

# Development Workbench

Load this once before starting an unfamiliar preview, simulator, or remote device workflow. Ordinary edits, questions, and single status checks use the normal tools.

## Pick the actual target

- Browser app or local API: inspect the chat with workspace_workbench action=activity. Reuse its running process when appropriate. Start the project's real command with workspace_run_command and keep the task ID. Use wait/check with the last output cursor. Publish the actual loopback address and task ID when known. Set reveal=true to show the service to the user or to open the visible browser preview for authorized UI inspection. Use browser status or snapshot, then act on fresh pixels and inspect the result.
- Android, iPhone, or iPad: call devices and read the computer, platform, and device status. Select an exact returned ID with select_device and set reveal=true when the user wants to watch. Start an off simulator with start_device, then wait for devices to report ready. Install an already built APK or simulator .app when needed, launch its real package or bundle ID, and capture the running screen. Use fresh captures for touch input. Only power off a virtual device at the user's request.
- Native desktop app or game: use the actual application window on a compatible host. Use authorized computer tools if declared. VirtualBox supports listing registered guests and requesting startup. Use its actual guest window for inspection.

## Resolve setup on the right computer

Android uses Platform Tools and a configured emulator or authorized Android device. Apple simulators need a Mac with Xcode and the relevant runtime. Windows and Linux users can add an accessible Mac in **Settings → Connections**. A simulator works without a physical iPhone. For live iPhone/iPad video and touch input install idb and idb_companion on that Mac. Screenshots can use Xcode alone. Other device form factors expose the controls their runtime supports.

For a missing SSH host, guide the user to **Settings → Connections → Add connection**. Use an SSH alias or user@host, and the existing trusted host key and account credentials. The user can choose an identity file under SSH options. Build artifacts must already be on the device's computer. Ask for the exact missing access, installed runtime, or artifact path only after inspecting what is available. Respect Computer Use and network permissions.

Use show_runs with a known task ID to bring relevant output into view. A published address is not proof a service is listening, and an accepted boot or input is not proof of its effect. Report separately what ran, what was observed, and what needs setup. Follow the user's limits on checks and tests.

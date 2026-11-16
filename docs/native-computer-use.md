# Native computer use

General and Coding Heavy can use `computer` and `screen_agent` to observe and operate native desktop applications. Enable **Settings → Computer → Allow computer actions**, enable the agent's desktop tools, and grant desktop access to the task. Browser access is a separate setting.

Desktop control has its own session, status endpoint, capture loop, and stop channel. Browser tools use their browser connection and browser access setting. Refreshing or reconnecting a browser does not start the desktop driver or replace its status. A desktop connection error does not mark unrelated browser or coding work as cancelled by the user.

Native control uses Cua Driver. Install the driver for the operating system, then use the desktop connection details in Settings to resolve missing permissions or start its service. On macOS, grant the permissions requested by the driver, including screen capture and accessibility. A locked screen, unavailable capture, protected application, or refused input returns an error. EterX does not switch to another desktop driver after a failure.

The Electron app must be reopened after changes to its main process, including the desktop activity overlay. A standalone web server has no OS overlay or native file-opening bridge.

## Models and visual context

Desktop screenshots are passed as native image inputs through the configured Gemini, Anthropic, or OpenAI-compatible provider adapter. There is no desktop-specific model-name or version allowlist. Older models work only if their actual API supports the required image and tool inputs. EterX does not switch models or replace missing screenshots with a text-only desktop workflow.

Screenshots stay separate from JSON tool-result compaction. The model receives the image alongside window identity, capture metadata and accessible controls. Desktop observations and input results are not reused from the intelligent tool cache.

Gemini Live receives tool screenshots as visual frames. OpenAI Realtime receives image conversation items. Other Live transports that cannot carry these images do not expose native computer control; the configured main agent remains available for desktop tasks.

## Selecting and operating a window

1. Use `list_apps` to discover window titles and exact `pid`/`window_id` pairs. A query can narrow large window lists.
2. Use `session_start`, `see` or `see_window` with the exact pair or a unique app/window title. Observation selects the window without raising it. `focus_app` explicitly raises a window. An initial discovery call also includes a screen capture.
3. Use current `element_token` values for accessible controls. Use coordinates from the returned screenshot for canvas input. Do not add display offsets or DPI scaling.
4. Inspect the observation returned after input. When `actionStatus` is `sent`, input was delivered; this alone does not establish that the task succeeded. When it is `unknown`, observe before deciding whether another action is necessary.
5. Continue choosing actions from the new screenshots. Call `session_stop` when desktop work is complete or when yielding control. A later native action can start another session within the same active task. Finishing the agent loop closes its native resources. Closing Live also retires its run identity so late requests cannot reopen the disconnected session.

The observe-act-observe session persists while the selected model decides its next step. Input actions automatically capture their results. When input needs a new observation, the tool captures one first and returns `observationRequired: true` with `actionStatus: "not_sent"`; the model must inspect it before requesting input. The tool never guesses an action from an unseen frame or automatically replays a prior input.

Each chat retains its selected target. `scope: "desktop"` explicitly selects the primary desktop capture; select an individual window to work on another display. The desktop overlay covers all connected displays. Actions are serialized across chats, and tokens belong to the latest observation of the selected target. Preview captures use a separate session so they do not replace the action's screenshot coordinates or tokens.

The display preview refreshes automatically between actions. A new action interrupts an in-progress preview capture, and no preview is queued ahead of input. There is no one-minute idle cutoff while the task's session remains active. Preview frames go to the desktop monitor; model decisions use the screenshots returned with tool results. A missed or interrupted preview frame does not end the task. Each session has its own driver identity, so delayed cleanup cannot close a newer session's target.

Use `find` with a label or `get_controls` to locate fields. If a tree is truncated, narrow the query before increasing `max_elements`. Ambiguous matches are returned for selection, rather than choosing an arbitrary control.

## Native actions

| Action | Input and behavior |
| --- | --- |
| `launch_app` | Opens an app by name; inspect its returned launch state and select the resulting window. |
| `open_file` / `open_url` | Electron opens an absolute file/folder/application path or an HTTP(S) URL using the OS handler. Observe the resulting window before input. |
| `type` / `type_into` | Unicode and multiline text, optionally addressed to a current token, named control or screenshot point. `delay_ms: 0` requests the fastest typing delivery. |
| `set_value` | Replaces a native field, dropdown or slider value using its current token. |
| `click`, `right_click`, `double_click`, `hover`, `drag`, `scroll` | Target-aware mouse input. Click and drag support explicit modifiers. |
| `key`, `select_all`, `copy`, `paste`, `save`, `undo`, `close_window` | Keyboard input with platform-specific common shortcuts. |
| `invoke_menu` | Invokes an exact array of native menu labels in `menu_path`. |
| `set_window_frame` | Moves/resizes a window using desktop bounds from `list_apps`, not screenshot pixels. |
| `wait_text`, `wait_change`, `wait_ms` | Bounded waits followed by observation. An image change alone does not prove semantic success. |
| `clipboard_get` / `clipboard_set` | Reads or writes clipboard text. |
| `session_start` / `session_stop` | Captures the initial screen and starts persistent native control, or ends that control and its overlay. |
| `stream_start` / `stream_stop` | Resumes or pauses the automatic low-frequency preview. Session control remains available until `session_stop`. |

Input uses background delivery by default. Select `delivery_mode: "foreground"` explicitly when the intended application requires visible input. Delivery mode never changes automatically. Text is sent through stdin rather than process arguments, avoiding Windows argument-length limits and keeping typed text out of command-line error messages. Typing timeouts account for the requested text length and delay.

## Desktop indicator and stopping

While a native session is active, Electron displays a thin blue perimeter with soft, slowly moving edge highlights. A compact charcoal banner at the top center reads **EterX Computer use · Press Esc to stop**. The center of the screen stays transparent. The overlay remains visible between tool calls while the model reasons, does not take focus or intercept mouse input, respects reduced-motion and increased-contrast preferences, and fades out when the session ends.

The overlay requests the full bounds of each connected display, including its taskbar or Dock area, using Electron's logical coordinates for display scaling. Only the banner is inset below a top menu bar; the perimeter is not restricted to the application work area. Bounds and stacking are reapplied after showing and while the session is active. Windows disables the invisible resizing frame and system window material. macOS uses a floating panel across Spaces and fullscreen applications. Display changes update the monitor layout.

Actual placement remains subject to the operating system and window manager. In particular, Electron on native Wayland cannot position or raise windows globally or show them without activation, so full desktop overlay coverage is not supported there by these APIs. No alternate desktop backend is selected automatically. See [Electron's window API platform notes](https://www.electronjs.org/docs/latest/api/browser-window).

Escape cancels active desktop activity and closes its sessions. The stopped run cannot resume queued native actions; a new task receives a new run identity. Screen lock, suspend, loss of the overlay connection, disabling Computer Use, and task cancellation also end active control. Input already delivered to an application cannot be undone by cancellation. Escape is reserved for stopping EterX; agents should use a named Cancel/Close control to dismiss application UI.

Startup gets a separate connection allowance. A single missed background heartbeat does not cancel the chat, and late replies after session cleanup are ignored. New native actions still require a confirmed stop-control connection. If that connection remains unavailable, native input stops with a specific error; only an actual Escape stop is propagated as a user cancellation. Desktop stop reasons are recorded in the Electron desktop log without screen contents or typed text.

## References

- [Cua Driver setup](https://cua.ai/docs/cua-driver/quickstart)
- [Cua apps, windows and screen](https://cua.ai/docs/cua-driver/reference/mcp-tools/apps-windows-and-screen)
- [Cua click and type](https://cua.ai/docs/cua-driver/reference/mcp-tools/click-and-type)
- [Cua CLI](https://cua.ai/docs/cua-driver/reference/cli)
- [OpenAI Realtime image input](https://developers.openai.com/api/docs/guides/realtime-conversations)

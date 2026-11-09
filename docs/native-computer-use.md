# Native computer use

General and Coding Heavy can use `computer` and `screen_agent` to observe and operate native desktop applications. Enable **Settings → Computer → Allow computer actions**, enable the agent's desktop tools, and grant desktop access to the task. Browser access is a separate setting.

Native control uses Cua Driver. Install the driver for the operating system, then use the desktop connection details in Settings to resolve missing permissions or start its service. On macOS, grant the permissions requested by the driver, including screen capture and accessibility. A locked screen, unavailable capture, protected application, or refused input returns an error. EterX does not switch to another desktop driver after a failure.

The Electron app must be reopened after changes to its main process, including the desktop activity overlay. A standalone web server has no OS overlay or native file-opening bridge.

## Models and visual context

Desktop screenshots are passed as native image inputs through the configured Gemini, Anthropic, or OpenAI-compatible provider adapter. There is no desktop-specific model-name or version allowlist. Older models work only if their actual API supports the required image and tool inputs. EterX does not switch models or replace missing screenshots with a text-only desktop workflow.

Screenshots stay separate from JSON tool-result compaction. The model receives the image alongside window identity, capture metadata and accessible controls. Desktop observations and input results are not reused from the intelligent tool cache.

Gemini Live receives tool screenshots as visual frames. OpenAI Realtime receives image conversation items. Other Live transports that cannot carry these images do not expose native computer control; the configured main agent remains available for desktop tasks.

## Selecting and operating a window

1. Use `list_apps` to discover window titles and exact `pid`/`window_id` pairs. A query can narrow large window lists.
2. Use `see` or `see_window` with the exact pair or a unique app/window title. Observation selects the window without raising it. `focus_app` explicitly raises a window.
3. Use current `element_token` values for accessible controls. Use coordinates from the returned screenshot for canvas input. Do not add display offsets or DPI scaling.
4. Inspect the observation returned after input. When `actionStatus` is `sent`, input was delivered; this alone does not establish that the task succeeded. When it is `unknown`, observe before deciding whether another action is necessary.

Each chat retains its selected target. `scope: "desktop"` explicitly selects the primary desktop capture; select an individual window to work on another display. The desktop overlay covers all connected displays. Actions are serialized across chats, and tokens belong to the latest observation of the selected target. Preview captures use a separate session so they do not replace the action's screenshot coordinates or tokens.

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
| `stream_start` / `stream_stop` | Starts or stops a low-frequency preview of the selected target. |

Input uses background delivery by default. Select `delivery_mode: "foreground"` explicitly when the intended application requires visible input. Delivery mode never changes automatically. Text is sent through stdin rather than process arguments, avoiding Windows argument-length limits and keeping typed text out of command-line error messages. Typing timeouts account for the requested text length and delay.

## Desktop indicator and stopping

While a native activity is active, Electron displays a transparent overlay with animated blue edges and corners, plus a top-centered **Press Escape to stop EterX computer use** banner. The overlay does not take focus or intercept mouse input, respects reduced-motion preferences, and fades out after activity ends.

Escape cancels active desktop activity and closes its sessions. The stopped run cannot resume queued native actions; a new task receives a new run identity. Screen lock, suspend, loss of the overlay connection, disabling Computer Use, and task cancellation also end active control. Input already delivered to an application cannot be undone by cancellation. Escape is reserved for stopping EterX; agents should use a named Cancel/Close control to dismiss application UI.

## References

- [Cua Driver setup](https://cua.ai/docs/cua-driver/quickstart)
- [Cua apps, windows and screen](https://cua.ai/docs/cua-driver/reference/mcp-tools/apps-windows-and-screen)
- [Cua click and type](https://cua.ai/docs/cua-driver/reference/mcp-tools/click-and-type)
- [Cua CLI](https://cua.ai/docs/cua-driver/reference/cli)
- [OpenAI Realtime image input](https://developers.openai.com/api/docs/guides/realtime-conversations)

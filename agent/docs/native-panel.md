# Native dockable chat panel: investigation (#8)

The chat panel (`agent/extension/chat_panel.lua`) is a script `Dialog`, so it floats above the editor. This note records how Aseprite's own panels are docked and what it would take to dock the chat panel the same way.

## How Aseprite docks its panels

- `MainWindow` (`src/app/ui/main_window.cpp`) owns two `Dock` widgets (`src/app/ui/dock.h`):
  - `m_dock`: fixed chrome, which is the menu bar, document tabs and layout selector (lines ~171–180).
  - `m_customizableDock`: the parts users can rearrange: color bar, status bar, context bar, tool bar, timeline and the workspace (lines ~402–465 build the default and mirrored layouts).
- A `Dock` has five sides (`LEFT`, `TOP`, `RIGHT`, `BOTTOM`, `CENTER`). `dock(side, widget, prefSize)` places a widget; `subdock(side)` nests another `Dock`. Splitters appear when a widget is `EXPANSIVE`.
- A widget opts in to docking by implementing `app::Dockable` (`src/app/ui/dockable.h`): `dockableAt()` says which sides are allowed, and `dockHandleSide()` says where the drag handle goes. `ColorBar`, `Timeline`, `ToolBar`, `ContextBar` and `StatusBar` all do this.
- Layouts are saved as XML (`src/app/ui/layout.cpp`). Saving writes each docked child's `id()` (`layout.cpp:64`). Loading maps element names back to widgets with a hard-coded list: `colorbar`, `contextbar`, `timeline`, `toolbar`, `workspace`, `statusbar` (`layout.cpp:110–129`). `Layouts` (`layouts.cpp`) stores the user's named layouts, and `LayoutSelector` switches between them.

## How script dialogs work

- `Dialog{...}` creates a `DialogWindow` (`src/app/script/dialog_class.cpp:74`): a `ui::Window` whose content is one `ui::Grid` (`m_grid`). Every widget a script adds (`dlg:canvas`, `dlg:entry`, ...) goes into that grid.
- `dlg:show{ wait = false }` opens it as a floating window. Scripts have no API that docks a widget into `MainWindow`.

## Options

| Option | What changes | Pros | Cons |
|---|---|---|---|
| A. Native C++ chat panel | New `ChatPanel : ui::Widget, Dockable` with its own log view and entry; talks to the bridge from C++ | Fully native look; docks like the timeline | Duplicates the Lua panel and the bridge protocol in C++; only useful to this fork |
| B. Dockable script dialogs | `Dialog{ dockable = true, id = "..." }`: instead of a window, the dialog's grid goes into a `ScriptPanel : ui::Widget, Dockable` docked in `m_customizableDock`; layouts save it as `script:<id>` | Chat panel code stays in Lua unchanged; every extension benefits; small enough to **propose upstream**, which the EULA allows | Needs care with layout load/save, plugin unload and dialog close |
| C. Workspace tab | A `WorkspaceView` (like `HomeView`) hosting the panel, so it opens as a tab next to sprites and can be split | Reuses workspace splitting | Still C++ UI; a tab competes with the sprite being edited |

## Recommendation: option B

It solves the problem for this panel without rewriting it, and it is a general feature useful to any extension with a tool panel, so it can be proposed upstream as a contribution.

### Implementation sketch

1. `src/app/ui/script_panel.h/.cpp`: `class ScriptPanel : public ui::VBox, public Dockable`, with a small title strip (drag handle and close button) and the dialog's `ui::Grid` as its child. `dockableAt()` returns `LEFT | RIGHT | BOTTOM | EXPANSIVE`.
2. `dialog_class.cpp`: accept `dockable = true` (and a required `id`) in `Dialog_new` (line ~347). In `Dialog_show` (line ~438), when dockable, move `m_grid` out of the window into a `ScriptPanel` and call `MainWindow::dockScriptPanel(panel, side)`. `dlg:close()` undocks it and returns the grid to the window.
3. `MainWindow`: keep a registry `std::map<std::string, ScriptPanel*>`. `dockScriptPanel` docks at the right of `m_customizableDock->center()` by default, then calls `saveActiveLayout()`.
4. `layout.cpp`: when saving, write `script:<id>` for script panels. When loading, look unknown names up in the registry and **skip** missing ones (an extension may be uninstalled). Today an unknown name leaves `widget == nullptr`, which must not reach `dock->dock()`.
5. Plugin unload (`Extension::exitScripts`, `src/app/extensions.cpp:952`): close and undock that plugin's panels.
6. Lua side: `chat_panel.lua` passes `dockable = true, id = "aseprite-agent.chat"` when the API exists (`app.apiVersion` check) and falls back to a floating dialog otherwise.

### Risks

- Layout XML from a newer build loaded in stock Aseprite must still load: unknown elements are already ignored as long as step 4 skips them.
- Script dialogs repaint and receive focus through the window. Moving the grid must keep `onpaint`, `onwheel` and keyboard focus working; test the canvas and entry widgets.
- Keyboard shortcuts: an entry inside a docked panel must take key events before the editor's shortcuts. The floating dialog gets this from being a window.

### Effort

About 2–3 days for a working version in this fork (steps 1–6), plus tests of layout save, load and reset. Upstreaming adds review time and API discussion.

## Licensing note

Changes to Aseprite's C++ source are for personal use or for proposing a contribution (EULA section 2(g)). Option B is designed to be proposed upstream. Do not distribute compiled builds of this fork.

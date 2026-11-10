// Aseprite
// Copyright (C) 2026  Igara Studio S.A.
//
// This program is distributed under the terms of
// the End-User License Agreement for Aseprite.

#ifdef HAVE_CONFIG_H
  #include "config.h"
#endif

#include "app/ui/script_panel.h"

#include "app/app.h"
#include "app/ini_file.h"
#include "app/ui/dock.h"
#include "app/ui/main_window.h"
#include "app/ui/workspace.h"
#include "ui/scale.h"
#include "ui/size_hint_event.h"

#include <algorithm>
#include <vector>

namespace app {

using namespace ui;

obs::signal<void(ScriptPanel*)> ScriptPanel::DockChanged;

namespace {

// Panels that want to be docked.
std::vector<ScriptPanel*> g_docked;

constexpr const char* kSection = "ScriptPanels";

const char* side_to_string(int side)
{
  switch (side) {
    case ui::LEFT:   return "left";
    case ui::TOP:    return "top";
    case ui::BOTTOM: return "bottom";
    default:         return "right";
  }
}

int side_from_string(const std::string& s)
{
  if (s == "left")
    return ui::LEFT;
  if (s == "top")
    return ui::TOP;
  if (s == "bottom")
    return ui::BOTTOM;
  return ui::RIGHT;
}

MainWindow* main_window()
{
  auto* app = App::instance();
  return app ? app->mainWindow() : nullptr;
}

} // namespace

ScriptPanel::ScriptPanel(const std::string& panelId, const std::string& title)
  : m_panelId(panelId)
  , m_title(title)
  , m_close("x")
{
  setId(("script-panel:" + panelId).c_str());
  m_title.setExpansive(true);
  m_header.addChild(&m_title);
  m_header.addChild(&m_close);
  addChild(&m_header);

  m_close.Click.connect([this] { CloseRequested(); });
}

ScriptPanel::~ScriptPanel()
{
  // The content belongs to the dialog; detach it so ~Widget() doesn't delete it.
  setContent(nullptr);
  undock();
  if (parent())
    parent()->removeChild(this);

  // Header widgets are members; remove them before ~Widget() runs.
  m_header.removeChild(&m_close);
  m_header.removeChild(&m_title);
  removeChild(&m_header);
}

void ScriptPanel::dock()
{
  m_wantsDock = true;
  if (std::find(g_docked.begin(), g_docked.end(), this) == g_docked.end())
    g_docked.push_back(this);
  if (!isDocked())
    attach();
}

void ScriptPanel::undock()
{
  m_wantsDock = false;
  g_docked.erase(std::remove(g_docked.begin(), g_docked.end(), this), g_docked.end());
  if (!isDocked())
    return;
  remember();
  if (auto* win = main_window()) {
    win->customizableDock()->undock(this);
    win->layout();
    win->invalidate();
  }
  else {
    parent()->removeChild(this);
  }
  DockChanged(this);
}

void ScriptPanel::attach()
{
  auto* win = main_window();
  if (!win || !win->getWorkspace())
    return;
  const int side = side_from_string(
    get_config_string(kSection, (m_panelId + ".side").c_str(), "right"));
  const bool horizontal = (side == ui::LEFT || side == ui::RIGHT);
  const int extent =
    get_config_int(kSection, (m_panelId + ".size").c_str(), horizontal ? 220 : 160);
  // The config stores UI units; the dock works in pixels.
  const int px = extent * guiscale();
  const gfx::Size size = horizontal ? gfx::Size(px, 0) : gfx::Size(0, px);
  win->customizableDock()->dockRelativeTo(win->getWorkspace(), side, this, size);
  win->layout();
  win->invalidate();
  DockChanged(this);
}

void ScriptPanel::remember()
{
  if (!isDocked())
    return;
  const int side = Dock::GetSide(this);
  if (side == 0 || side == ui::CENTER)
    return;
  set_config_string(kSection, (m_panelId + ".side").c_str(), side_to_string(side));
  const bool horizontal = (side == ui::LEFT || side == ui::RIGHT);
  const gfx::Rect rc = bounds();
  if (!rc.isEmpty())
    set_config_int(kSection,
                   (m_panelId + ".size").c_str(),
                   (horizontal ? rc.w : rc.h) / guiscale());
}

// static
void ScriptPanel::RedockAll()
{
  for (auto* panel : std::vector<ScriptPanel*>(g_docked)) {
    if (panel->m_wantsDock && !panel->isDocked())
      panel->attach();
  }
}

// static
void ScriptPanel::RememberAll()
{
  for (auto* panel : g_docked)
    panel->remember();
}

void ScriptPanel::setContent(ui::Widget* content)
{
  if (m_content == content)
    return;
  if (m_content)
    removeChild(m_content);
  m_content = content;
  if (m_content) {
    m_content->setExpansive(true);
    addChild(m_content);
  }
  layout();
  invalidate();
}

int ScriptPanel::dockableAt() const
{
  return ui::LEFT | ui::RIGHT | ui::TOP | ui::BOTTOM | ui::EXPANSIVE;
}

void ScriptPanel::onSizeHint(SizeHintEvent& ev)
{
  VBox::onSizeHint(ev);
  // A sensible minimum so a freshly docked panel is usable.
  gfx::Size sz = ev.sizeHint();
  sz.w = std::max(sz.w, 160 * guiscale());
  ev.setSizeHint(sz);
}

} // namespace app

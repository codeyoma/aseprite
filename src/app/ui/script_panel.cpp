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
#include "app/ui/main_window.h"
#include "ui/scale.h"
#include "ui/size_hint_event.h"

#include <algorithm>

namespace app {

using namespace ui;

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

  if (auto* app = App::instance()) {
    if (auto* mainWindow = app->mainWindow())
      mainWindow->undockScriptPanel(this);
  }
  if (parent())
    parent()->removeChild(this);

  // Header widgets are members; remove them before ~Widget() runs.
  m_header.removeChild(&m_close);
  m_header.removeChild(&m_title);
  removeChild(&m_header);
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

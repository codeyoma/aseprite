// Aseprite
// Copyright (C) 2026  Igara Studio S.A.
//
// This program is distributed under the terms of
// the End-User License Agreement for Aseprite.

#ifdef HAVE_CONFIG_H
  #include "config.h"
#endif

#include "app/ui/agent_button.h"

#include "app/commands/commands.h"
#include "app/ui/script_panel.h"
#include "app/ui/skin/skin_theme.h"
#include "app/ui_context.h"
#include "ui/alert.h"
#include "ui/graphics.h"
#include "ui/paint_event.h"
#include "ui/scale.h"
#include "ui/size_hint_event.h"

namespace app {

using namespace ui;
using namespace app::skin;

AgentButton::AgentButton() : Button("AI")
{
  initTheme();
  // Highlighted while the chat panel is docked.
  m_dockConn = ScriptPanel::DockChanged.connect([this](ScriptPanel* panel) {
    if (panel->panelId() == kPanelId)
      setSelected(panel->isDocked());
  });
}

void AgentButton::onClick()
{
  Button::onClick();

  Command* cmd = Commands::instance()->byId(kCommandId);
  if (!cmd) {
    ui::Alert::show(
      "AI Agent<<The AI Agent extension is not installed.<<Install aseprite-agent.aseprite-extension "
      "from Edit > Preferences > Extensions.||&OK");
    return;
  }
  UIContext::instance()->executeCommand(cmd);
}

void AgentButton::onSizeHint(SizeHintEvent& ev)
{
  const gfx::Size textSize = this->textSize();
  ev.setSizeHint(textSize.w + 8 * guiscale(), textSize.h + 4 * guiscale());
}

void AgentButton::onPaint(PaintEvent& ev)
{
  const auto* theme = SkinTheme::get(this);
  Graphics* g = ev.graphics();
  gfx::Color fg, bg;

  // Selected = the chat panel is open (set by MainWindow).
  if (isSelected()) {
    fg = theme->colors.menuitemHighlightText();
    bg = theme->colors.menuitemHighlightFace();
  }
  else if (isEnabled() && hasMouse()) {
    fg = theme->colors.menuitemHotText();
    bg = theme->colors.menuitemHotFace();
  }
  else {
    fg = theme->colors.menuitemNormalText();
    bg = bgColor();
  }

  const gfx::Rect bounds = clientBounds();
  g->fillRect(bg, bounds);

  const gfx::Size textSize = this->textSize();
  g->drawText(
    text(),
    fg,
    bg,
    gfx::Point(bounds.x + bounds.w / 2 - textSize.w / 2, bounds.y + bounds.h / 2 - textSize.h / 2));
}

} // namespace app

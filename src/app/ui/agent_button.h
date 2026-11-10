// Aseprite
// Copyright (C) 2026  Igara Studio S.A.
//
// This program is distributed under the terms of
// the End-User License Agreement for Aseprite.

#ifndef APP_UI_AGENT_BUTTON_H_INCLUDED
#define APP_UI_AGENT_BUTTON_H_INCLUDED
#pragma once

#include "obs/connection.h"
#include "ui/button.h"

namespace app {

// "AI" button next to the workspace layout button. It runs the AI Agent
// extension's "AgentChat" command, which opens or closes the chat panel.
class AgentButton : public ui::Button {
public:
  // Id of the plugin command and of the chat panel (script panel id).
  static constexpr const char* kCommandId = "AgentChat";
  static constexpr const char* kPanelId = "aseprite-agent.chat";

  AgentButton();

private:
  obs::scoped_connection m_dockConn;

public:
protected:
  void onClick() override;
  void onSizeHint(ui::SizeHintEvent& ev) override;
  void onPaint(ui::PaintEvent& ev) override;
};

} // namespace app

#endif

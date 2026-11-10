// Aseprite
// Copyright (C) 2026  Igara Studio S.A.
//
// This program is distributed under the terms of
// the End-User License Agreement for Aseprite.

#ifndef APP_UI_SCRIPT_PANEL_H_INCLUDED
#define APP_UI_SCRIPT_PANEL_H_INCLUDED
#pragma once

#include "app/ui/dockable.h"
#include "obs/signal.h"
#include "ui/box.h"
#include "ui/button.h"
#include "ui/label.h"

#include <string>

namespace app {

// A script dialog docked in the main window (Dialog{ dockable=true }).
// It shows a small title bar and hosts the dialog's content widget,
// which still belongs to the dialog: the panel never deletes it.
class ScriptPanel : public ui::VBox,
                    public Dockable {
public:
  ScriptPanel(const std::string& panelId, const std::string& title);
  ~ScriptPanel();

  const std::string& panelId() const { return m_panelId; }

  // Puts the dialog content inside the panel (or removes it with nullptr).
  void setContent(ui::Widget* content);
  ui::Widget* content() const { return m_content; }

  // Dockable
  int dockableAt() const override;
  int dockHandleSide() const override { return ui::TOP; }

  // The user pressed the close button.
  obs::signal<void()> CloseRequested;

private:
  void onSizeHint(ui::SizeHintEvent& ev) override;

  std::string m_panelId;
  ui::HBox m_header;
  ui::Label m_title;
  ui::Button m_close;
  ui::Widget* m_content = nullptr;
};

} // namespace app

#endif

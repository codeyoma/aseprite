// Aseprite
// Copyright (C) 2026  Igara Studio S.A.
//
// This program is distributed under the terms of
// the End-User License Agreement for Aseprite.

#ifdef HAVE_CONFIG_H
  #include "config.h"
#endif

#include "app/app.h"
#include "app/commands/new_params.h"
#include "app/context.h"
#include "app/ui/layout.h"
#include "app/ui/layout_selector.h"
#include "app/ui/main_window.h"

namespace app {

struct SetWorkspaceLayoutParams : public NewParams {
  // "default", "mirrored", or the id of a user-defined layout.
  Param<std::string> layout{ this, std::string("default"), "layout" };
};

// Switches the workspace layout without the layout selector UI, so
// scripts and agents can change it.
class SetWorkspaceLayoutCommand : public CommandWithNewParams<SetWorkspaceLayoutParams> {
public:
  SetWorkspaceLayoutCommand() : CommandWithNewParams(CommandId::SetWorkspaceLayout()) {}

protected:
  bool onEnabled(Context* ctx) override
  {
    return ctx->isUIAvailable() && App::instance()->mainWindow();
  }

  void onExecute(Context* ctx) override
  {
    std::string id = params().layout();
    if (id.empty() || id == "default")
      id = Layout::kDefault;
    else if (id == "mirrored")
      id = Layout::kMirroredDefault;
    App::instance()->mainWindow()->layoutSelector()->switchToLayout(id);
  }
};

Command* CommandFactory::createSetWorkspaceLayoutCommand()
{
  return new SetWorkspaceLayoutCommand;
}

} // namespace app

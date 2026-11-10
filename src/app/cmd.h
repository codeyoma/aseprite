// Aseprite
// Copyright (C) 2023  Igara Studio SA
// Copyright (C) 2001-2018  David Capello
//
// This program is distributed under the terms of
// the End-User License Agreement for Aseprite.

#ifndef APP_CMD_H_INCLUDED
#define APP_CMD_H_INCLUDED
#pragma once

#include "base/disable_copying.h"
#include "undo/undo_command.h"

#include <cstdint>
#include <string>

namespace app {

class Context;

class Cmd : public undo::UndoCommand {
public:
  Cmd();
  virtual ~Cmd();

  void execute(Context* ctx);

  // undo::UndoCommand impl
  void undo() override;
  void redo() override;
  void dispose() override;

  std::string label() const;
  size_t memSize() const;

  Context* context() const { return m_ctx; }

  // This fork: a sequential id, unique for the process lifetime (never
  // reused, unlike the command's memory), so scripts can remember a
  // position in the undo history (sprite.undoHistory, sprite:undoTo).
  uint64_t seqId() const { return m_seqId; }

protected:
  virtual void onExecute();
  virtual void onUndo();
  virtual void onRedo();
  virtual void onFireNotifications();
  virtual std::string onLabel() const;
  virtual size_t onMemSize() const;

private:
  // TODO I think we could just remove this field (but we'll need to
  //      include the Context* in all onEvent() member functions)
  Context* m_ctx;
  uint64_t m_seqId;
#if _DEBUG
  enum class State { NotExecuted, Executed, Undone, Redone };
  State m_state;
#endif

  DISABLE_COPYING(Cmd);
};

} // namespace app

#endif

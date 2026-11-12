// Aseprite
// Copyright (c) 2022-2025  Igara Studio S.A.
//
// This program is distributed under the terms of
// the End-User License Agreement for Aseprite.

#include "app/script/canvas_widget.h"

#include "app/color_spaces.h"
#include "app/script/graphics_context.h"
#include "app/ui/skin/skin_theme.h"
#include "os/system.h"
#include "ui/display.h"
#include "ui/message.h"
#include "ui/paint_event.h"
#include "ui/resize_event.h"
#include "ui/size_hint_event.h"
#include "ui/system.h"

#if LAF_SKIA
  #include "include/core/SkFont.h"
  #include "include/core/SkSurfaceProps.h"
  #include "os/skia/skia_surface.h"
  #include "text/skia_font.h"
#endif

#if LAF_WINDOWS
  #include <windows.h>
#endif

namespace app { namespace script {

#if LAF_SKIA
// The subpixel order Windows draws ClearType text with, or unknown when the
// user turned ClearType off (and on other platforms: macOS has no LCD text).
static SkPixelGeometry lcd_geometry()
{
  #if LAF_WINDOWS
  UINT type = 0, orientation = FE_FONTSMOOTHINGORIENTATIONRGB;
  if (!SystemParametersInfoW(SPI_GETFONTSMOOTHINGTYPE, 0, &type, 0) || type != FE_FONTSMOOTHINGCLEARTYPE)
    return kUnknown_SkPixelGeometry;
  SystemParametersInfoW(SPI_GETFONTSMOOTHINGORIENTATION, 0, &orientation, 0);
  return (orientation == FE_FONTSMOOTHINGORIENTATIONBGR ? kBGR_H_SkPixelGeometry :
                                                          kRGB_H_SkPixelGeometry);
  #else
  return kUnknown_SkPixelGeometry;
  #endif
}
#endif

// static
ui::WidgetType Canvas::Type()
{
  static ui::WidgetType type = ui::kGenericWidget;
  if (type == ui::kGenericWidget)
    type = ui::register_widget_type();
  return type;
}

// static
bool Canvas::s_stopKeyEventPropagation = false;

// static
void Canvas::stopKeyEventPropagation()
{
  s_stopKeyEventPropagation = true;
}

// static
bool Canvas::takeStopKeyEventPropagation()
{
  const bool stop = s_stopKeyEventPropagation;
  s_stopKeyEventPropagation = false;
  return stop;
}

Canvas::Canvas() : ui::Widget(Type())
{
}

void Canvas::callPaint()
{
  if (!m_surface)
    return;

  os::Paint p;
  p.color(bgColor(), m_surface->colorSpace().get());
  m_surface->drawRect(m_surface->bounds(), p);

  // Draw only on resize (onPaint we draw the cached m_surface)
  GraphicsContext gc(m_surface, m_autoScaling ? ui::guiscale() : 1);
  if (m_autoScaling) {
    auto theme = skin::SkinTheme::get(this);
    gc.font(theme->getUnscaledFont(font()));
  }
  else
    gc.font(paintFont());

  Paint(gc);
}

// A full-resolution canvas surface. With Windows ClearType it is opaque and
// knows the screen's subpixel order, so text gets LCD antialiasing like the
// rest of Windows (Skia falls back to grayscale without the order). Only
// when the surface reaches the screen 1:1: with Screen Scaling above 100%
// the window doubles each pixel, and with it each subpixel color.
os::SurfaceRef Canvas::makeSurface(int w, int h, const os::ColorSpaceRef& cs)
{
  os::SurfaceRef surface = os::System::instance()->makeSurface(w, h, cs);
  m_lcdText = false;
#if LAF_SKIA
  const ui::Display* display = this->display();
  const bool oneToOne = (!m_autoScaling && display && display->scale() == 1);
  const SkPixelGeometry geometry = (oneToOne ? lcd_geometry() : kUnknown_SkPixelGeometry);
  if (geometry != kUnknown_SkPixelGeometry) {
    if (auto* skiaSurface = dynamic_cast<os::SkiaSurface*>(surface.get())) {
      skiaSurface->setPixelGeometry(geometry);
      m_lcdText = true;
    }
  }
#endif
  return surface;
}

// The font text is painted with: the widget's own, or on an LCD surface a
// copy of it with LCD edging (the widget's font is shared with labels, which
// are drawn elsewhere).
text::FontRef Canvas::paintFont()
{
  text::FontRef font = this->font();
#if LAF_SKIA
  if (m_lcdText) {
    if (m_lcdFontSource != font.get()) {
      m_lcdFontSource = font.get();
      m_lcdFont = nullptr;
      if (auto* skiaFont = dynamic_cast<text::SkiaFont*>(font.get())) {
        SkFont lcd = skiaFont->skFont();
        lcd.setEdging(SkFont::Edging::kSubpixelAntiAlias);
        m_lcdFont = base::make_ref<text::SkiaFont>(lcd);
      }
    }
    if (m_lcdFont)
      return m_lcdFont;
  }
#endif
  return font;
}

void Canvas::onInitTheme(ui::InitThemeEvent& ev)
{
  Widget::onInitTheme(ev);

  gfx::Color bg;
  if (auto theme = skin::SkinTheme::get(this))
    bg = theme->colors.windowFace();
  else
    bg = gfx::rgba(0, 0, 0);
  setBgColor(bg);
}

template<typename T>
static T makeScaled(T* msg, const gfx::Point& offset)
{
  static_assert(std::is_base_of<ui::Message, T>::value,
                "type parameter must derive from ui::Message");
  auto result = T(msg->type(), *msg, ((msg->position() - offset) / ui::guiscale()) + offset);
  result.setRecipient(static_cast<ui::Message*>(msg)->recipient());
  result.setDisplay(static_cast<ui::Message*>(msg)->display());
  return result;
}

bool Canvas::onProcessMessage(ui::Message* msg)
{
  switch (msg->type()) {
    case ui::kKeyDownMessage:
      if (hasFocus()) {
        s_stopKeyEventPropagation = false;
        auto keyMsg = static_cast<ui::KeyMessage*>(msg);
        KeyDown(keyMsg);
        if (s_stopKeyEventPropagation)
          return true;
      }
      break;

    case ui::kKeyUpMessage:
      if (hasFocus()) {
        s_stopKeyEventPropagation = false;
        auto keyMsg = static_cast<ui::KeyMessage*>(msg);
        KeyUp(keyMsg);
        if (s_stopKeyEventPropagation)
          return true;
      }
      break;

    case ui::kSetCursorMessage: ui::set_mouse_cursor(m_cursorType); return true;

    case ui::kMouseMoveMessage: {
      auto mouseMsg = *static_cast<ui::MouseMessage*>(msg);
      if (m_autoScaling) {
        mouseMsg = makeScaled(&mouseMsg, bounds().origin());
      }
      MouseMove(&mouseMsg);
      break;
    }

    case ui::kMouseDownMessage: {
      if (!hasCapture())
        captureMouse();

      if (isFocusStop() && !hasFocus())
        requestFocus();

      auto mouseMsg = *static_cast<ui::MouseMessage*>(msg);
      if (m_autoScaling) {
        mouseMsg = makeScaled(&mouseMsg, bounds().origin());
      }
      MouseDown(&mouseMsg);
      break;
    }

    case ui::kMouseUpMessage: {
      auto mouseMsg = *static_cast<ui::MouseMessage*>(msg);
      if (m_autoScaling) {
        mouseMsg = makeScaled(&mouseMsg, bounds().origin());
      }
      MouseUp(&mouseMsg);

      if (hasCapture())
        releaseMouse();
      break;
    }

    case ui::kDoubleClickMessage: {
      auto mouseMsg = *static_cast<ui::MouseMessage*>(msg);
      if (m_autoScaling) {
        mouseMsg = makeScaled(&mouseMsg, bounds().origin());
      }
      DoubleClick(&mouseMsg);
      break;
    }

    case ui::kMouseWheelMessage:
      if (Wheel) {
        auto mouseMsg = *static_cast<ui::MouseMessage*>(msg);
        if (m_autoScaling) {
          mouseMsg = makeScaled(&mouseMsg, bounds().origin());
        }
        Wheel(&mouseMsg);
        return true;
      }
      break;

    case ui::kTouchMagnifyMessage: {
      auto touchMsg = *static_cast<ui::TouchMessage*>(msg);
      if (m_autoScaling) {
        touchMsg = makeScaled(&touchMsg, bounds().origin());
      }
      TouchMagnify(&touchMsg);
      break;
    }
  }
  return ui::Widget::onProcessMessage(msg);
}

void Canvas::onResize(ui::ResizeEvent& ev)
{
  Widget::onResize(ev);

  const os::SystemRef system = os::System::instance();
  if (system && !ev.bounds().isEmpty()) {
    int w = ev.bounds().w;
    int h = ev.bounds().h;

    if (m_autoScaling) {
      w = w / ui::guiscale() + (w % ui::guiscale());
      h = h / ui::guiscale() + (h % ui::guiscale());
    }

    if (!m_surface || m_surface->width() != w || m_surface->height() != h) {
      ui::Display* display = this->display();
      os::ColorSpaceRef cs = (display ? display->colorSpace() : nullptr);
      m_surface = makeSurface(w, h, cs);
      callPaint();
    }
  }
  else
    m_surface.reset();
}

void Canvas::onPaint(ui::PaintEvent& ev)
{
  auto g = ev.graphics();
  gfx::Rect rc = clientBounds();
  if (m_surface) {
    if (m_autoScaling) {
      rc.w += (rc.w % ui::guiscale());
      rc.h += (rc.h % ui::guiscale());
    }
    g->drawSurface(m_surface.get(), m_surface->bounds(), rc, os::Sampling(), nullptr);
  }
}

}} // namespace app::script

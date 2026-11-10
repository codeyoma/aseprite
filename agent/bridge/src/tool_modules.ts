// The registry of tool modules: each *_tools.ts adds one import and one
// entry here, and TOOLS, the MCP server and the tests pick it up.
import type { Tool } from "./tool.js";
import { CORE_TOOLS } from "./core_tools.js";
import { COMMAND_TOOLS } from "./command_tools.js";
import { TIMELINE_TOOLS } from "./timeline_tools.js";
import { GUIDE_TOOLS } from "./guide_tools.js";
import { COLOR_TOOLS } from "./color_tools.js";
import { PIXEL_TOOLS } from "./pixel_tools.js";
import { SHEET_TOOLS } from "./sheet_tools.js";
import { RECREATE_TOOLS } from "./recreate_tools.js";
import { SHADING_TOOLS } from "./shading_tools.js";
import { ANIMATION_TOOLS } from "./animation_tools.js";
import { DIRECTION_TOOLS } from "./direction_tools.js";
import { TILE_TOOLS } from "./tile_tools.js";
import { DITHER_TOOLS } from "./dither_tools.js";
import { NORMAL_TOOLS } from "./normal_tools.js";
import { EXPORT_TOOLS } from "./export_tools.js";
import { UI_TOOLS } from "./ui_tools.js";
import { VOXEL_TOOLS } from "./voxel_tools.js";
import { MODEL_TOOLS } from "./model_tools.js";
import { FX_TOOLS } from "./fx_tools.js";
import { FX_TIMING_TOOLS } from "./fx_timing_tools.js";

export const TOOL_MODULES: { what: string; tools: Tool[] }[] = [
  { what: "Core: state, Lua, snapshots, checks, undo, sub-agents", tools: CORE_TOOLS },
  { what: "Aseprite commands and Saved Commands (#26)", tools: COMMAND_TOOLS },
  { what: "Timeline as text", tools: TIMELINE_TOOLS },
  { what: "Guide and Skill Catalog (#35)", tools: GUIDE_TOOLS },
  { what: "Palette and tone tools (#36, #38)", tools: COLOR_TOOLS },
  { what: "Pixel snap tools (#37)", tools: PIXEL_TOOLS },
  { what: "Sprite sheet import (#41)", tools: SHEET_TOOLS },
  { what: "Recreate from a reference (#40)", tools: RECREATE_TOOLS },
  { what: "Ramps, shading and outlines (#39)", tools: SHADING_TOOLS },
  { what: "Animation helpers (#42)", tools: ANIMATION_TOOLS },
  { what: "Directions (#43)", tools: DIRECTION_TOOLS },
  { what: "Tilesets and autotiles (#46)", tools: TILE_TOOLS },
  { what: "Dithering and palette swaps (#48)", tools: DITHER_TOOLS },
  { what: "Normal maps and 2D lighting (#47)", tools: NORMAL_TOOLS },
  { what: "Export for game engines (#49)", tools: EXPORT_TOOLS },
  { what: "Pixel text and UI elements (#50)", tools: UI_TOOLS },
  { what: "Voxels and 2.5D (#45)", tools: VOXEL_TOOLS },
  { what: "3D model to pixel sprites (#44)", tools: MODEL_TOOLS },
  { what: "Pixel FX library (#69)", tools: FX_TOOLS },
  { what: "FX on a character's timeline: overlay and hit-stop (#70)", tools: FX_TIMING_TOOLS },
];

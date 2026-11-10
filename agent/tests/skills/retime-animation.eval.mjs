export default {
  skill: "retime-animation",
  skip: {
    reason: "get_timeline_text and apply_timeline_text are extension requests (timeline text is built and parsed in Lua)",
    luaTest: "timeline_text_test.lua",
  },
};

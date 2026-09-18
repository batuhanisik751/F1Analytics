// Section identity for the strategy simulator (SIM_SPEC §0.1, §9 D1). Kept in a plain module (no
// "use client") so the server page can read the strings: exports of a client module become client
// references on the server and are not usable as values there.
export const SIM_SECTION_ID = "simulator";
export const SIM_SECTION_TITLE = "What if they had pitted on lap 22?";
export const SIM_SECTION_SUBTITLE =
  "Edit one driver's strategy and simulate it against what they really did — clean-air time only.";

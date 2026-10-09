// Edge entry point (DESIGN §6.3): immediate-send, lands in #22. Must never import a Node
// built-in (CLAUDE.md invariant 8): import from src/core, never from src/index or src/node.
export {};

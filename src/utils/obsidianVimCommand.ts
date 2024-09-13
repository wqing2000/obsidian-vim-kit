/**
 * Utility types and functions for defining Obsidian-specific Vim commands.
 */

import type { Editor as CodeMirrorEditor } from "codemirror";
import type VimkitPlugin from "../main";
import type { MotionFn, VimApi } from "./vimApi";

export type ObsidianActionFn = (
  vimrcPlugin: VimkitPlugin,  // Included so we can run Obsidian commands as part of the action
  cm: CodeMirrorEditor,
  actionArgs: { repeat: number },
) => void;

export function defineAndMapObsidianVimMotion(
  vimObject: VimApi,
  motionFn: MotionFn,
  mapping: string
) {
  vimObject.defineMotion(motionFn.name, motionFn);
  vimObject.mapCommand(mapping, "motion", motionFn.name, undefined, {});
}

export function defineAndMapObsidianVimAction(
  vimObject: VimApi,
  vimrcPlugin: VimkitPlugin,
  obsidianActionFn: ObsidianActionFn,
  mapping: string
) {
  vimObject.defineAction(obsidianActionFn.name, (cm, actionArgs) => {
    obsidianActionFn(vimrcPlugin, cm, actionArgs);
  });
  vimObject.mapCommand(mapping, "action", obsidianActionFn.name, undefined, {});
}

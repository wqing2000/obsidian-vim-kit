// @ts-ignore
import * as keyFromAccelerator from 'keyboardevent-from-electron-accelerator';
import { EditorSelection, MarkdownView, Notice, Editor as ObsidianEditor, Plugin } from 'obsidian';

import { followLinkUnderCursor } from './actions/followLinkUnderCursor';
import { moveDownSkippingFolds, moveUpSkippingFolds } from './actions/moveSkippingFolds';
import { jumpToNextHeading, jumpToPreviousHeading } from './motions/jumpToHeading';
import { jumpToNextLink, jumpToPreviousLink } from './motions/jumpToLink';
import { defineAndMapObsidianVimAction, defineAndMapObsidianVimMotion } from './utils/obsidianVimCommand';
import { VimApi } from './utils/vimApi';
import * as CodeMirror from 'codemirror'; // Importing CodeMirror Types. In Obsidian, CodeMirror is a global object.
import { DEFAULT_SETTINGS, VimkitSettings, VimkitSettingTab } from './settings';
import tlds from './config/tlds';
import { createMarker, findMarkerMatch, updateMarkerText, type MarkerData } from './utils/createMarker';

// type CodeMirrorVimObject = typeof CodeMirror.Vim;
// // 定义 CodeMirrorAdapter 的类型
// interface CodeMirrorAdapter {
// 	Vim: CodeMirrorVimObject;
// }

const enum vimStatus {
	normal = 'normal',
	insert = 'insert',
	visual = 'visual',
	replace = 'replace',
}
type VimStatusPrompt = string;
export type VimStatusPromptMap = {
	[status in vimStatus]: VimStatusPrompt;
};

const vimStatusPromptClass = "vimrc-support-vim-mode";

// NOTE: to future maintainers, please make sure all mapping commands are included in this array.
const mappingCommands: string[] = [
	"map",
	"nmap",
	"noremap",
	"iunmap",
	"nunmap",
	"vunmap",
]

function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export default class VimkitPlugin extends Plugin {
	settings: VimkitSettings;

	private codeMirrorVimObject: any = null;
	private initialized = false;

	private lastYankBuffer: string[] = [""];
	private lastSystemClipboard = "";
	private yankToSystemClipboard = false;
	private currentKeyChord: any = [];
	private vimChordStatusBar: HTMLElement = null as unknown as HTMLElement;
	private vimStatusBar: HTMLElement = null as unknown as HTMLElement;
	private currentVimStatus: vimStatus = vimStatus.normal;
	private customVimKeybinds: { [name: string]: boolean } = {};
	private currentSelection: [EditorSelection] = null as unknown as [EditorSelection];
	private isInsertMode = false;

	// vimium variables
	showMarkers = false;
	markers: MarkerData[] = [];
	containerEl: HTMLElement;
	input = "";

	updateVimStatusBar() {
		this.vimStatusBar.setText(
			this.settings.vimStatusPromptMap[this.currentVimStatus]
		);
		this.vimStatusBar.dataset.vimMode = this.currentVimStatus;
	}

	async captureKeyboardLayout() {
		// This is experimental API and it might break at some point:
		// https://developer.mozilla.org/en-US/docs/Web/API/KeyboardLayoutMap
		const keyMap: Record<string, string> = {};
		const layout = await (navigator as any).keyboard.getLayoutMap();
		const doneIterating = new Promise<void>((resolve, reject) => {
			let counted = 0;
			layout.forEach((value: any, index: any) => {
				keyMap[index] = value;
				counted += 1;
				if (counted === layout.size)
					resolve();
			});
		});
		await doneIterating;
		new Notice('Keyboard layout captured');
		return keyMap;
	}

	async initialize() {
		if (this.initialized)
			return;

		this.codeMirrorVimObject = (window as any).CodeMirrorAdapter?.Vim;

		this.registerYankEvents(activeWindow);
		this.app.workspace.on("window-open", (workspaceWindow, w) => {
			this.registerYankEvents(w);
		})

		this.prepareChordDisplay();
		this.prepareVimModeDisplay();

		// Two events cos
		// this don't trigger on loading/reloading obsidian with note opened
		this.app.workspace.on("active-leaf-change", async () => {
			this.updateSelectionEvent();

			this.updateVimEvents();
		});
		// and this don't trigger on opening same file in new pane
		this.app.workspace.on("file-open", async () => {
			this.updateSelectionEvent();

			this.updateVimEvents();
		});

		this.initialized = true;
	}

	registerYankEvents(win: Window) {
		this.registerDomEvent(win.document, 'click', () => {
			this.captureYankBuffer(win);
		});
		this.registerDomEvent(win.document, 'keyup', () => {
			this.captureYankBuffer(win);
		});
		this.registerDomEvent(win.document, 'focusin', () => {
			this.captureYankBuffer(win);
		})
	}

	async updateSelectionEvent() {
		const view = this.getActiveView();
		if (!view) return;

		const cm = this.getCodeMirror(view);
		if (
			this.getCursorActivityHandlers(cm).some(
				(e: { name: string }) => e.name === "updateSelection")
		) return;
		cm.on("cursorActivity", async (cm: CodeMirror.Editor) => this.updateSelection(cm));
	}

	async updateSelection(cm: any) {
		this.currentSelection = cm.listSelections();
	}

	private getCursorActivityHandlers(cm: CodeMirror.Editor) {
		return (cm as any)._handlers.cursorActivity;
	}

	async updateVimEvents() {
		if (!(this.app as any).isVimEnabled())
			return;
		const view = this.getActiveView();
		if (view) {
			const cmEditor = this.getCodeMirror(view);

			// See https://codemirror.net/doc/manual.html#vimapi_events for events.
			this.isInsertMode = false;
			this.currentVimStatus = vimStatus.normal;
			if (this.settings.displayVimMode)
				this.updateVimStatusBar();
			cmEditor.off('vim-mode-change', this.logVimModeChange);
			cmEditor.on('vim-mode-change', this.logVimModeChange);

			this.currentKeyChord = [];
			cmEditor.off('vim-keypress', this.onVimKeypress);
			cmEditor.on('vim-keypress', this.onVimKeypress);
			cmEditor.off('vim-command-done', this.onVimCommandDone);
			cmEditor.on('vim-command-done', this.onVimCommandDone);
			CodeMirror.off(cmEditor.getInputField(), 'keydown', this.onKeydown);
			CodeMirror.on(cmEditor.getInputField(), 'keydown', this.onKeydown);
		}
	}

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new VimkitSettingTab(this.app, this));

		console.log('loading Vimkit plugin');

		this.app.workspace.on('active-leaf-change', async () => {
			if (!this.initialized)
				await this.initialize();
			if (this.codeMirrorVimObject.loadedVimrc)
				return;
			let fileName = this.settings.vimrcFileName;
			if (!fileName || fileName.trim().length === 0) {
				fileName = DEFAULT_SETTINGS.vimrcFileName;
				console.log('Configured Vimrc file name is illegal, falling-back to default');
			}
			let vimrcContent = '';
			try {
				vimrcContent = await this.app.vault.adapter.read(fileName);
			} catch (e) {
				console.log('Error loading vimrc file', fileName, 'from the vault root', e.message)
			}
			this.readVimInit(vimrcContent);
		});

		// vimium init
		this.addCommand({
			id: 'show-markers',
			name: 'Show markers',
			callback: () => {
				if (this.showMarkers) {
					this.destroyMarkers();
					this.input = "";
				}
				this.showMarkers = true;
				this.createMarkers();
			}
		});

		this.registerDomEvent(document, "keydown", (event: KeyboardEvent) => {
			if (!this.showMarkers) {
				return;
			}

			if (event.key === "Escape") {
				this.showMarkers = false;
				this.input = "";
				this.destroyMarkers();
			} else if (event.key === "Backspace") {
				// TODO: bug: 在vim insert模式下，按下 Backspace 会删除笔记内容的字符。
				if (this.input === "") {
					return;
				}
				this.input = this.input.slice(0, -1);
				this.updateMarkers();
			} else if (event.key.length === 1 && event.key.match(/[a-zA-Z]/)) {
				this.input += event.key.toLowerCase();

				const result = findMarkerMatch(this.input, this.markers);
				if (result) {
					// Interact with element
					const clickableEl = result.parentEl;
					if (clickableEl.getAttribute('contenteditable') === 'true') {
						clickableEl.focus();
					} else {
						clickableEl.click();
					}

					// Reset
					this.showMarkers = false;
					this.destroyMarkers();
					this.input = "";
				} else {
					this.updateMarkers();
				}
			}

			event.preventDefault();
		});

		this.registerDomEvent(document, "mousedown", () => {
			if (!this.showMarkers) {
				return;
			}

			this.showMarkers = false;
			this.input = "";
			this.destroyMarkers();
		});

		this.registerEvent(this.app.workspace.on("resize", () => {
			if (this.showMarkers) {
				this.updateMarkers();
			}
		}));
	}

	async loadSettings() {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	logVimModeChange = async (cm: any) => {
		if (!cm) return;
		this.isInsertMode = cm.mode === 'insert';
		switch (cm.mode) {
			case "insert":
				this.currentVimStatus = vimStatus.insert;
				break;
			case "normal":
				this.currentVimStatus = vimStatus.normal;
				break;
			case "visual":
				this.currentVimStatus = vimStatus.visual;
				break;
			case "replace":
				this.currentVimStatus = vimStatus.replace;
				break;
			default:
				break;
		}
		if (this.settings.displayVimMode)
			this.updateVimStatusBar();
	}

	onunload() {
		console.log('unloading Vimkit plugin (but Vim commands that were already loaded will still work)');
	}

	private getActiveView(): MarkdownView | null {
		return this.app.workspace.getActiveViewOfType(MarkdownView);
	}

	getActiveObsidianEditor(): ObsidianEditor {
		return this.getActiveView().editor;
	}

	private getCodeMirror(view: MarkdownView): CodeMirror.Editor {
		return (view as any).editMode?.editor?.cm?.cm;
	}

	readVimInit(vimCommands: string) {
		const view = this.getActiveView();
		if (view) {
			const cmEditor = this.getCodeMirror(view);
			if (cmEditor && !this.codeMirrorVimObject.loadedVimrc) {
				this.defineBasicCommands(this.codeMirrorVimObject);
				this.defineAndMapObsidianVimCommands(this.codeMirrorVimObject);
				this.defineSendKeys(this.codeMirrorVimObject);
				this.defineObCommand(this.codeMirrorVimObject);
				this.defineSurround(this.codeMirrorVimObject);
				this.defineJsCommand(this.codeMirrorVimObject);
				this.defineJsFile(this.codeMirrorVimObject);
				this.defineSource(this.codeMirrorVimObject);

				this.loadVimCommands(vimCommands);

				// Make sure that we load it just once per CodeMirror instance.
				// This is supposed to work because the Vim state is kept at the keymap level, hopefully
				// there will not be bugs caused by operations that are kept at the object level instead
				this.codeMirrorVimObject.loadedVimrc = true;
			}

			if (cmEditor) {
				cmEditor.off('vim-mode-change', this.logVimModeChange);
				cmEditor.on('vim-mode-change', this.logVimModeChange);
				CodeMirror.off(cmEditor.getInputField(), 'keydown', this.onKeydown);
				CodeMirror.on(cmEditor.getInputField(), 'keydown', this.onKeydown);
			}
		}
	}

	loadVimCommands(vimCommands: string) {
		const view = this.getActiveView();
		if (view) {
			const cmEditor = this.getCodeMirror(view);

			vimCommands.split("\n").forEach(
				function (line: string, index: number, arr: [string]) {
					if (line.trim().length > 0 && line.trim()[0] != '"') {
						const split = line.split(" ")
						if (mappingCommands.includes(split[0])) {
							// Have to do this because "vim-command-done" event doesn't actually work properly, or something.
							this.customVimKeybinds[split[1]] = true
						}
						this.codeMirrorVimObject.handleEx(cmEditor, line);
					}
				}.bind(this) // Faster than an arrow function. https://stackoverflow.com/questions/50375440/binding-vs-arrow-function-for-react-onclick-event
			)
		}
	}

	defineBasicCommands(vimObject: any) {
		vimObject.defineOption('clipboard', '', 'string', ['clip'], (value: string, cm: any) => {
			if (value) {
				if (value.trim() == 'unnamed' || value.trim() == 'unnamedplus') {
					if (!this.yankToSystemClipboard) {
						this.yankToSystemClipboard = true;
						console.log("Vim is now set to yank to system clipboard.");
					}
				} else {
					throw new Error("Unrecognized clipboard option, supported are 'unnamed' and 'unnamedplus' (and they do the same)")
				}
			}
		});

		vimObject.defineOption('tabstop', 4, 'number', [], (value: number, cm: any) => {
			if (value && cm) {
				cm.setOption('tabSize', value);
			}
		});

		vimObject.defineEx('iunmap', '', (cm: any, params: any) => {
			if (params.argString.trim()) {
				this.codeMirrorVimObject.unmap(params.argString.trim(), 'insert');
			}
		});

		vimObject.defineEx('nunmap', '', (cm: any, params: any) => {
			if (params.argString.trim()) {
				this.codeMirrorVimObject.unmap(params.argString.trim(), 'normal');
			}
		});

		vimObject.defineEx('vunmap', '', (cm: any, params: any) => {
			if (params.argString.trim()) {
				this.codeMirrorVimObject.unmap(params.argString.trim(), 'visual');
			}
		});

		vimObject.defineEx('noremap', '', (cm: any, params: any) => {
			if (!params?.args?.length) {
				throw new Error('Invalid mapping: noremap');
			}

			if (params.argString.trim()) {
				this.codeMirrorVimObject.noremap.apply(this.codeMirrorVimObject, params.args);
			}
		});

		// Allow the user to register an Ex command
		vimObject.defineEx('exmap', '', (cm: any, params: any) => {
			if (params?.args?.length && params.args.length < 2) {
				throw new Error(`exmap requires at least 2 parameters: [name] [actions...]`);
			}
			const commandName = params.args[0];
			params.args.shift();
			const commandContent = params.args.join(' ');
			// The content of the user's Ex command is just the remaining parameters of the exmap command
			this.codeMirrorVimObject.defineEx(commandName, '', (cm: any, params: any) => {
				this.codeMirrorVimObject.handleEx(cm, commandContent);
			});
		});
	}

	defineAndMapObsidianVimCommands(vimObject: VimApi) {
		defineAndMapObsidianVimMotion(vimObject, jumpToNextHeading, ']]');
		defineAndMapObsidianVimMotion(vimObject, jumpToPreviousHeading, '[[');
		defineAndMapObsidianVimMotion(vimObject, jumpToNextLink, 'gl');
		defineAndMapObsidianVimMotion(vimObject, jumpToPreviousLink, 'gL');

		defineAndMapObsidianVimAction(vimObject, this, moveDownSkippingFolds, 'zj');
		defineAndMapObsidianVimAction(vimObject, this, moveUpSkippingFolds, 'zk');
		defineAndMapObsidianVimAction(vimObject, this, followLinkUnderCursor, 'gf');
	}

	defineSendKeys(vimObject: any) {
		vimObject.defineEx('sendkeys', '', async (cm: any, params: any) => {
			if (!params?.args?.length) {
				console.log(params);
				throw new Error(`The sendkeys command requires a list of keys, e.g. sendKeys Ctrl+p a b Enter`);
			}

			let allGood = true;
			const events: KeyboardEvent[] = [];
			for (const key of params.args) {
				if (key.startsWith('wait')) {
					const delay = key.slice(4);
					await sleep(delay * 1000);
				}
				else {
					let keyEvent: KeyboardEvent;
					try {
						keyEvent = new KeyboardEvent('keydown', keyFromAccelerator.toKeyEvent(key));
						events.push(keyEvent);
					}
					catch (e) {
						allGood = false;
						throw new Error(`Key '${key}' couldn't be read as an Electron Accelerator`);
					}
					if (allGood) {
						for (keyEvent of events)
							window.postMessage(JSON.parse(JSON.stringify(keyEvent)), '*');
						// view.containerEl.dispatchEvent(keyEvent);
					}
				}
			}
		});
	}

	executeObsidianCommand(commandName: string) {
		const availableCommands = (this.app as any).commands.commands;
		if (!(commandName in availableCommands)) {
			throw new Error(`Command ${commandName} was not found, try 'obcommand' with no params to see in the developer console what's available`);
		}
		const view = this.getActiveView();
		const editor = view.editor;
		const command = availableCommands[commandName];
		const { callback, checkCallback, editorCallback, editorCheckCallback } = command;
		if (editorCheckCallback)
			editorCheckCallback(false, editor, view);
		else if (editorCallback)
			editorCallback(editor, view);
		else if (checkCallback)
			checkCallback(false);
		else if (callback)
			callback();
		else
			throw new Error(`Command ${commandName} doesn't have an Obsidian callback`);
	}

	defineObCommand(vimObject: any) {
		vimObject.defineEx('obcommand', '', async (cm: any, params: any) => {
			if (!params?.args?.length || params.args.length != 1) {
				const availableCommands = (this.app as any).commands.commands;
				console.log(`Available commands: ${Object.keys(availableCommands).join('\n')}`)
				throw new Error(`obcommand requires exactly 1 parameter`);
			}
			const commandName = params.args[0];
			this.executeObsidianCommand(commandName);
		});
	}

	defineSurround(vimObject: any) {
		// Function to surround selected text or highlighted word.
		const surroundFunc = (params: string[]) => {
			const editor = this.getActiveView().editor;
			if (!params.length) {
				throw new Error("surround requires exactly 2 parameters: prefix and postfix text.");
			}
			const newArgs = params.join(" ").match(/(\\.|[^\s\\\\]+)+/g);
			if (newArgs.length != 2) {
				throw new Error("surround requires exactly 2 parameters: prefix and postfix text.");
			}

			const beginning = newArgs[0].replace("\\\\", "\\").replace("\\ ", " "); // Get the beginning surround text
			const ending = newArgs[1].replace("\\\\", "\\").replace("\\ ", " "); // Get the ending surround text

			const currentSelections = this.currentSelection;
			let chosenSelection = currentSelections?.[0] ? currentSelections[0] : { anchor: editor.getCursor(), head: editor.getCursor() };
			if (currentSelections?.length > 1) {
				console.log("WARNING: Multiple selections in surround. Attempt to select matching cursor. (obsidian-vimrc-support)")
				const cursorPos = editor.getCursor();
				for (const selection of currentSelections) {
					if (selection.head.line == cursorPos.line && selection.head.ch == cursorPos.ch) {
						console.log("RESOLVED: Selection matching cursor found. (obsidian-vimrc-support)")
						chosenSelection = selection;
						break;
					}
				}
			}
			if (editor.posToOffset(chosenSelection.anchor) === editor.posToOffset(chosenSelection.head)) {
				// No range of selected text, so select word.
				const wordAt = editor.wordAt(chosenSelection.head);
				if (wordAt) {
					chosenSelection = { anchor: wordAt.from, head: wordAt.to };
				}
			}
			let currText;
			if (editor.posToOffset(chosenSelection.anchor) > editor.posToOffset(chosenSelection.head)) {
				currText = editor.getRange(chosenSelection.head, chosenSelection.anchor);
			} else {
				currText = editor.getRange(chosenSelection.anchor, chosenSelection.head);
			}
			editor.replaceRange(beginning + currText + ending, chosenSelection.anchor, chosenSelection.head);
			// If no selection, place cursor between beginning and ending
			if (editor.posToOffset(chosenSelection.anchor) === editor.posToOffset(chosenSelection.head)) {
				chosenSelection.head.ch += beginning.length;
				editor.setCursor(chosenSelection.head);
			}
		}

		vimObject.defineEx("surround", "", (cm: any, params: any) => { surroundFunc(params.args); });

		vimObject.defineEx("pasteinto", "", (cm: any, params: any) => {
			// Using the register for when this.yankToSystemClipboard == false
			surroundFunc(
				['[',
					'](' + vimObject.getRegisterController().getRegister('yank').keyBuffer + ")"]);
		})

		const editor = this.getActiveView().editor;
		// Handle the surround dialog input
		const surroundDialogCallback = (value: string) => {
			if ((/^\[+$/).test(value)) { // check for 1-inf [ and match them with ]
				surroundFunc([value, "]".repeat(value.length)])
			} else if ((/^\(+$/).test(value)) { // check for 1-inf ( and match them with )
				surroundFunc([value, ")".repeat(value.length)])
			} else if ((/^\{+$/).test(value)) { // check for 1-inf { and match them with }
				surroundFunc([value, "}".repeat(value.length)])
			} else { // Else, just put it before and after.
				surroundFunc([value, value])
			}
		}

		vimObject.defineOperator("surroundOperator", () => {
			const p = "<span>Surround with: <input type='text'></span>"
			CodeMirror.openDialog(p, surroundDialogCallback, { bottom: true, selectValueOnOpen: false })
		})


		vimObject.mapCommand("<A-y>s", "operator", "surroundOperator")

	}

	async captureYankBuffer(win: Window) {
		if (!this.yankToSystemClipboard) {
			return
		}

		const yankRegister = this.codeMirrorVimObject.getRegisterController().getRegister('yank');
		const currentYankBuffer = yankRegister.keyBuffer;

		// yank -> clipboard
		const buf = currentYankBuffer[0]
		if (buf !== this.lastYankBuffer[0]) {
			await win.navigator.clipboard.writeText(buf);
			this.lastYankBuffer = currentYankBuffer;
			this.lastSystemClipboard = await win.navigator.clipboard.readText();
			return
		}

		// clipboard -> yank
		try {
			const currentClipboardText = await win.navigator.clipboard.readText();
			if (currentClipboardText !== this.lastSystemClipboard) {
				yankRegister.setText(currentClipboardText);
				this.lastYankBuffer = yankRegister.keyBuffer;
				this.lastSystemClipboard = currentClipboardText;
			}
		} catch (e) {
			// XXX: Avoid "Uncaught (in promise) DOMException: Document is not focused."
			// XXX: It is not good but easy workaround
		}
	}

	prepareChordDisplay() {
		if (this.settings.displayChord) {
			// Add status bar item
			this.vimChordStatusBar = this.addStatusBarItem();

			// Move vimChordStatusBar to the leftmost position and center it.
			const parent = this.vimChordStatusBar.parentElement;
			this.vimChordStatusBar.parentElement.insertBefore(this.vimChordStatusBar, parent.firstChild);
			this.vimChordStatusBar.style.marginRight = "auto";

			const cmEditor = this.getCodeMirror(this.getActiveView());
			// See https://codemirror.net/doc/manual.html#vimapi_events for events.
			cmEditor.off('vim-keypress', this.onVimKeypress);
			cmEditor.on('vim-keypress', this.onVimKeypress);
			cmEditor.off('vim-command-done', this.onVimCommandDone);
			cmEditor.on('vim-command-done', this.onVimCommandDone);
		}
	}

	onVimKeypress = async (vimKey: any) => {
		if (vimKey != "<Esc>") { // TODO figure out what to actually look for to exit commands.
			this.currentKeyChord.push(vimKey);
			if (this.customVimKeybinds[this.currentKeyChord.join("")] != undefined) { // Custom key chord exists.
				this.currentKeyChord = [];
			}
		} else {
			this.currentKeyChord = [];
		}

		// Build keychord text
		let tempS = "";
		for (const s of this.currentKeyChord) {
			tempS += " " + s;
		}
		if (tempS != "") {
			tempS += "-";
		}
		this.vimChordStatusBar?.setText(tempS);
	}

	onVimCommandDone = async (reason: any) => {
		this.vimChordStatusBar?.setText("");
		this.currentKeyChord = [];
	}

	prepareVimModeDisplay() {
		if (this.settings.displayVimMode) {
			this.vimStatusBar = this.addStatusBarItem() // Add status bar item
			this.vimStatusBar.setText(
				this.settings.vimStatusPromptMap[vimStatus.normal]
			); // Init the vimStatusBar with normal mode
			this.vimStatusBar.addClass(vimStatusPromptClass);
			this.vimStatusBar.dataset.vimMode = this.currentVimStatus;
		}
	}

	onKeydown = (ev: KeyboardEvent) => {
		if (this.showMarkers) {
			return;
		}

		if (this.settings.fixedNormalModeLayout) {
			const keyMap = this.settings.capturedKeyboardMap;
			if (!this.isInsertMode && !ev.shiftKey &&
				ev.code in keyMap && ev.key != keyMap[ev.code]) {
				const view = this.getActiveView();
				if (view) {
					const cmEditor = this.getCodeMirror(view);
					if (cmEditor) {
						this.codeMirrorVimObject.handleKey(cmEditor, keyMap[ev.code], 'mapping');
					}
				}
				ev.preventDefault();
				return false;
			}
		}
	}

	defineJsCommand(vimObject: any) {
		vimObject.defineEx('jscommand', '', (cm: any, params: any) => {
			if (!this.settings.supportJsCommands)
				throw new Error("JS commands are turned off; enable them via the Vimrc plugin configuration if you're sure you know what you're doing");
			const jsCode = params.argString.trim() as string;
			if (jsCode[0] != '{' || jsCode[jsCode.length - 1] != '}')
				throw new Error("Expected an argument which is JS code surrounded by curly brackets: {...}");
			const currentSelections = this.currentSelection;
			const chosenSelection = currentSelections && currentSelections.length > 0 ? currentSelections[0] : null;
			const command = Function('editor', 'view', 'selection', jsCode);
			const view = this.getActiveView();
			command(view.editor, view, chosenSelection);
		});
	}

	defineJsFile(vimObject: any) {
		vimObject.defineEx('jsfile', '', async (cm: any, params: any) => {
			if (!this.settings.supportJsCommands)
				throw new Error("JS commands are turned off; enable them via the Vimrc plugin configuration if you're sure you know what you're doing");
			if (params?.args?.length < 1)
				throw new Error("Expected format: fileName {extraCode}");
			let extraCode = '';
			const fileName = params.args[0];
			if (params.args.length > 1) {
				params.args.shift();
				extraCode = params.args.join(' ').trim() as string;
				if (extraCode[0] != '{' || extraCode[extraCode.length - 1] != '}')
					throw new Error("Expected an extra code argument which is JS code surrounded by curly brackets: {...}");
			}
			const currentSelections = this.currentSelection;
			const chosenSelection = currentSelections && currentSelections.length > 0 ? currentSelections[0] : null;
			let content = '';
			try {
				content = await this.app.vault.adapter.read(fileName);
			} catch (e) {
				throw new Error(`Cannot read file ${params.args[0]} from vault root: ${e.message}`);
			}
			const command = Function('editor', 'view', 'selection', content + extraCode);
			const view = this.getActiveView();
			command(view.editor, view, chosenSelection);
		});
	}

	defineSource(vimObject: any) {
		vimObject.defineEx('source', '', async (cm: any, params: any) => {
			if (params?.args?.length > 1)
				throw new Error("Expected format: source [fileName]");
			const fileName = params.argString.trim();
			try {
				this.app.vault.adapter.read(fileName).then(vimrcContent => {
					this.loadVimCommands(vimrcContent);
				});
			} catch (e) {
				console.log('Error loading vimrc file', fileName, 'from the vault root', e.message)
			}
		});
	}

	// vimium functions
	createMarkers() {
		// Select clickable elements
		const clickableElements = document.querySelectorAll(this.settings.clickableCssSelector);

		// Create container
		this.containerEl = createDiv();
		this.containerEl.addClass("vimium-container");
		this.app.workspace.containerEl.appendChild(this.containerEl);
		const containerInnerEl = createDiv();
		containerInnerEl.addClass("vimium-container-inner");
		this.containerEl.appendChild(containerInnerEl);
		this.containerEl.setCssProps({
			"--marker-size": `${this.settings.markerSize}px`,
			"--marker-color": this.settings.markerColor,
			"--marker-background-color": this.settings.markerBackgroundColor,
			"--marker-opacity": `${this.settings.markerOpacity}`,
		});

		// Create markers
		for (let i = 0; i < Math.min(clickableElements.length, tlds.length); i++) {
			const clickableEl = clickableElements[i] as HTMLElement;
			const text = tlds[i];
			const marker = createMarker(text, clickableEl, this.input);
			if (marker) {
				this.markers.push(marker);
				containerInnerEl.appendChild(marker.el);
			}
		}
	}

	updateMarkers() {
		for (const marker of this.markers) {
			const rect = marker.parentEl.getBoundingClientRect();
			marker.el.setCssProps({
				"--top": `${rect.top}px`,
				"--left": `${rect.left}px`,
				display: marker.text.startsWith(this.input) ? "block" : "none"
			});
			updateMarkerText(marker, this.input);
		}
	}

	destroyMarkers() {
		// Remove parent container
		this.containerEl.parentNode?.removeChild(this.containerEl);

		// Delete markers
		this.markers = [];
	}
}

import { App, ButtonComponent, PluginSettingTab, Setting } from "obsidian";
import { CLICKABLE_SELECTOR } from "./config/selector-list";
import type VimkitPlugin from "./main";
import type { VimStatusPromptMap } from "./main";

export interface VimkitSettings {
	vimrcFileName: string,
	displayChord: boolean,
	displayVimMode: boolean,
	fixedNormalModeLayout: boolean,
	capturedKeyboardMap: Record<string, string>,
	supportJsCommands: boolean
	vimStatusPromptMap: VimStatusPromptMap;
	clickableCssSelector: string;
	markerSize: number;
}

export const DEFAULT_SETTINGS: VimkitSettings = {
	vimrcFileName: ".obsidian.vimrc",
	displayChord: false,
	displayVimMode: false,
	fixedNormalModeLayout: false,
	capturedKeyboardMap: {},
	supportJsCommands: false,
	vimStatusPromptMap: {
		normal: '🟢',
		insert: '🟠',
		visual: '🟡',
		replace: '🔴',
	},
	clickableCssSelector: CLICKABLE_SELECTOR,
	markerSize: 12,
}

export class VimkitSettingTab extends PluginSettingTab {
	plugin: VimkitPlugin;

	constructor(app: App, plugin: VimkitPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Vimkit Settings' });

		new Setting(containerEl)
			.setName('Vimrc file name')
			.setDesc('Relative to vault directory (requires restart)')
			.addText((text) => {
				text.setPlaceholder(DEFAULT_SETTINGS.vimrcFileName);
				text.setValue(this.plugin.settings.vimrcFileName || DEFAULT_SETTINGS.vimrcFileName);
				text.onChange(value => {
					this.plugin.settings.vimrcFileName = value;
					this.plugin.saveSettings();
				})
			});

		new Setting(containerEl)
			.setName('Vim chord display')
			.setDesc('Displays the current chord until completion. Ex: "<Space> f-" (requires restart)')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.displayChord || DEFAULT_SETTINGS.displayChord);
				toggle.onChange(value => {
					this.plugin.settings.displayChord = value;
					this.plugin.saveSettings();
				})
			});

		new Setting(containerEl)
			.setName('Vim mode display')
			.setDesc('Displays the current vim mode (requires restart)')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.displayVimMode || DEFAULT_SETTINGS.displayVimMode);
				toggle.onChange(value => {
					this.plugin.settings.displayVimMode = value;
					this.plugin.saveSettings();
				})
			});

		new Setting(containerEl)
			.setName('Use a fixed keyboard layout for Normal mode')
			.setDesc('Define a keyboard layout to always use when in Normal mode, regardless of the input language (experimental).')
			.addButton(async (button) => {
				button.setButtonText('Capture current layout');
				button.onClick(async () => {
					this.plugin.settings.capturedKeyboardMap = await this.plugin.captureKeyboardLayout();
					this.plugin.saveSettings();
				});
			})
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.fixedNormalModeLayout || DEFAULT_SETTINGS.fixedNormalModeLayout);
				toggle.onChange(async value => {
					this.plugin.settings.fixedNormalModeLayout = value;
					if (value && Object.keys(this.plugin.settings.capturedKeyboardMap).length === 0)
						this.plugin.settings.capturedKeyboardMap = await this.plugin.captureKeyboardLayout();
					this.plugin.saveSettings();
				});
			})

		new Setting(containerEl)
			.setName('Support JS commands (beware!)')
			.setDesc("Support the 'jscommand' and 'jsfile' commands, which allow defining Ex commands using Javascript. WARNING! Review the README to understand why this may be dangerous before enabling.")
			.addToggle(toggle => {
				toggle.setValue(this.plugin.settings.supportJsCommands ?? DEFAULT_SETTINGS.supportJsCommands);
				toggle.onChange(value => {
					this.plugin.settings.supportJsCommands = value;
					this.plugin.saveSettings();
				})
			});

		containerEl.createEl('h2', { text: 'Vim Mode Display Prompt' });

		new Setting(containerEl)
			.setName('Normal mode prompt')
			.setDesc('Set the status prompt text for normal mode.')
			.addText((text) => {
				text.setPlaceholder('Default: 🟢');
				text.setValue(
					this.plugin.settings.vimStatusPromptMap.normal ||
					DEFAULT_SETTINGS.vimStatusPromptMap.normal
				);
				text.onChange((value) => {
					this.plugin.settings.vimStatusPromptMap.normal = value ||
						DEFAULT_SETTINGS.vimStatusPromptMap.normal;
					this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Insert mode prompt')
			.setDesc('Set the status prompt text for insert mode.')
			.addText((text) => {
				text.setPlaceholder('Default: 🟠');
				text.setValue(
					this.plugin.settings.vimStatusPromptMap.insert ||
					DEFAULT_SETTINGS.vimStatusPromptMap.insert
				);
				text.onChange((value) => {
					this.plugin.settings.vimStatusPromptMap.insert = value ||
						DEFAULT_SETTINGS.vimStatusPromptMap.insert;
					console.log(this.plugin.settings.vimStatusPromptMap);
					this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Visual mode prompt')
			.setDesc('Set the status prompt text for visual mode.')
			.addText((text) => {
				text.setPlaceholder('Default: 🟡');
				text.setValue(
					this.plugin.settings.vimStatusPromptMap.visual ||
					DEFAULT_SETTINGS.vimStatusPromptMap.visual
				);
				text.onChange((value) => {
					this.plugin.settings.vimStatusPromptMap.visual = value ||
						DEFAULT_SETTINGS.vimStatusPromptMap.visual;
					this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Replace mode prompt')
			.setDesc('Set the status prompt text for replace mode.')
			.addText((text) => {
				text.setPlaceholder('Default: 🔴');
				text.setValue(
					this.plugin.settings.vimStatusPromptMap.replace ||
					DEFAULT_SETTINGS.vimStatusPromptMap.replace
				);
				text.onChange((value) => {
					this.plugin.settings.vimStatusPromptMap.replace = value ||
						DEFAULT_SETTINGS.vimStatusPromptMap.replace;
					this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Marker font size')
			.setDesc('The size of text in markers.')
			.addText(text => text
				.setValue(this.plugin.settings.markerSize.toString())
				.onChange(async (value) => {
					const num = parseInt(value);
					if (isNaN(num)) {
						this.plugin.settings.markerSize = DEFAULT_SETTINGS.markerSize;
					} else {
						this.plugin.settings.markerSize = num;
					}
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Clickable CSS selector')
			.setDesc('Used for selecting clickable HTML elements.')
			.addTextArea(text => text
				.setPlaceholder('CSS selector..')
				.setValue(this.plugin.settings.clickableCssSelector)
				.onChange(async (value) => {
					this.plugin.settings.clickableCssSelector = value;
					await this.plugin.saveSettings();
				}));

		new ButtonComponent(containerEl)
			.setButtonText("Reset")
			.setTooltip("Reset settings")
			.onClick(async () => {
				this.plugin.settings.clickableCssSelector = CLICKABLE_SELECTOR;
				await this.plugin.saveSettings();
				this.display();
			});
	}
}

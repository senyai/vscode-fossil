/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// based on https://github.com/Microsoft/vscode/commit/41f0ff15d7327da30fdae73aa04ca570ce34fa0a

import { ExtensionContext, window, Disposable, commands, WebviewViewProvider, WebviewView, WebviewViewResolveContext, CancellationToken, SnippetString, Webview, Uri } from 'vscode';
import { Model } from './model';
import { CommandCenter } from './commands';
import { FossilFileSystemProvider } from './fileSystemProvider';
import * as nls from 'vscode-nls';
import typedConfig from './config';
import { findFossil } from './fossilFinder';
import { provideVSCodeDesignSystem, vsCodeButton } from "@vscode/webview-ui-toolkit";

provideVSCodeDesignSystem().register(vsCodeButton());


export const localize = nls.loadMessageBundle();

class PikchrViewProvider implements WebviewViewProvider {
	private _view?: WebviewView;

	constructor(
		private readonly _extensionUri: Uri,
	) { }

	public resolveWebviewView(
		webviewView: WebviewView,
		context: WebviewViewResolveContext,
		_token: CancellationToken,
	): void {
		this._view = webviewView;

		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,

			localResourceRoots: [
				this._extensionUri
			]
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		// webviewView.webview.onDidReceiveMessage(data => {
		// 	switch (data.type) {
		// 		case 'colorSelected':
		// 			{
		// 				window.activeTextEditor?.insertSnippet(new SnippetString(`#${data.value}`));
		// 				break;
		// 			}
		// 	}
		// });
	}

    private _getHtmlForWebview(webview: Webview) {
		// Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
		// const scriptUri = webview.asWebviewUri(Uri.joinPath(this._extensionUri, 'media', 'main.js'));

		// Do the same for the stylesheet.
		// const styleResetUri = webview.asWebviewUri(Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
		// const styleVSCodeUri = webview.asWebviewUri(Uri.joinPath(this._extensionUri, 'media', 'css'));
		// const styleMainUri = webview.asWebviewUri(Uri.joinPath(this._extensionUri, 'media', 'main.css'));

		// Use a nonce to only allow a specific script to be run.
		const nonce = getNonce();

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Cat Colors</title>
			</head>
			<body>
            <h1>
            GET IN!
			</h1>
			<vscode-button appearance="icon">
				<span class="codicon codicon-check"></span>
		  	</vscode-button>
			<vscode-button id="howdy">Howdy!</vscode-button>

			</body>
			</html>`;
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

async function init(
    context: ExtensionContext,
    disposables: Disposable[]
): Promise<Model | undefined> {

	const provider = new PikchrViewProvider(context.extensionUri);

	disposables.push(
		window.registerWebviewViewProvider('fossil.pikchr', provider));


    // const { name, version, aiKey } = require(context.asAbsolutePath('./package.json')) as { name: string, version: string, aiKey: string };

    const outputChannel = window.createOutputChannel('Fossil');
    disposables.push(outputChannel);

    const executable = await findFossil(typedConfig.path, outputChannel);
    const model = new Model(executable);
    disposables.push(model);

    const onRepository = () =>
        commands.executeCommand(
            'setContext',
            'fossilOpenRepositoryCount',
            model.repositories.length
        );
    model.onDidOpenRepository(onRepository, null, disposables);
    model.onDidCloseRepository(onRepository, null, disposables);
    onRepository();

    if (!typedConfig.enabled) {
        const commandCenter = new CommandCenter(
            executable,
            model,
            outputChannel,
            context
        );
        disposables.push(commandCenter);
        return;
    }

    executable.onOutput(str => outputChannel.append(str), null, disposables);

    disposables.push(
        new CommandCenter(executable, model, outputChannel, context),
        new FossilFileSystemProvider(model)
    );
    return model;
}

export async function activate(
    context: ExtensionContext
): Promise<void | Model> {
    const disposables: Disposable[] = [];
    context.subscriptions.push(
        new Disposable(() => Disposable.from(...disposables).dispose())
    );

    return init(context, disposables).catch(err => console.error(err));
}

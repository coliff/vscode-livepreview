import * as Stream from 'stream';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import * as mime from 'mime';
import * as nls from 'vscode-nls';
import { Disposable } from '../../utils/dispose';
import {
	FormatFileSize,
	FormatDateTime,
	isFileInjectable,
} from '../../utils/utils';
import { HTMLInjector } from './HTMLInjector';
import TelemetryReporter from 'vscode-extension-telemetry';
import { WorkspaceManager } from '../../infoManagers/workspaceManager';
import { EndpointManager } from '../../infoManagers/endpointManager';
import { PathUtil } from '../../utils/pathUtil';
import { INJECTED_ENDPOINT_NAME } from '../../utils/constants';
import { ConnectionManager } from '../../infoManagers/connectionManager';

const localize = nls.loadMessageBundle();

/**
 * @description the response information to give back to the server object
 */
export interface RespInfo {
	ContentType: string | undefined;
	Stream: Stream.Readable | fs.ReadStream | undefined;
}

/**
 * @description table entry for a file in the auto-generated index.
 */
export interface IndexFileEntry {
	LinkSrc: string;
	LinkName: string;
	FileSize: string;
	DateTime: string;
}

/**
 * @description table entry for a directory in the auto-generated index.
 */
export interface IndexDirEntry {
	LinkSrc: string;
	LinkName: string;
	DateTime: string;
}

/**
 * @description object responsible for loading content requested by the HTTP server.
 */
export class ContentLoader extends Disposable {
	private _scriptInjector: HTMLInjector | undefined;
	private _servedFiles: Set<string> = new Set<string>();
	private _insertionTags = ['head', 'body', 'html', '!DOCTYPE'];

	constructor(
		_extensionUri: vscode.Uri,
		private readonly _reporter: TelemetryReporter,
		private readonly _endpointManager: EndpointManager,
		private readonly _workspaceManager: WorkspaceManager,
		_connectionManager: ConnectionManager
	) {
		super();
		this._scriptInjector = new HTMLInjector(_extensionUri, _connectionManager);
	}

	/**
	 * @description reset the list of served files; served files are used to watch changes for when being changed in the editor.
	 */
	public resetServedFiles(): void {
		this._servedFiles = new Set<string>();
	}

	/**
	 * @returns the files served by the HTTP server
	 */
	public get servedFiles(): Set<string> {
		return this._servedFiles;
	}

	/**
	 * @returns the script tags needed to reference the custom script endpoint.
	 */
	private get _scriptInjection(): string {
		return `<script type="text/javascript" src="${INJECTED_ENDPOINT_NAME}"></script>`;
	}

	/**
	 * @returns {RespInfo} the injected script and its content type.
	 */
	public loadInjectedJS(): RespInfo {
		const fileString = this._scriptInjector?.script ?? '';

		return {
			Stream: Stream.Readable.from(fileString),
			ContentType: 'text/javascript; charset=UTF-8',
		};
	}

	/**
	 * @description create a "page does not exist" page to pair with the 404 error.
	 * @param relativePath the path that does not exist
	 * @returns {RespInfo} the response information
	 */
	public createPageDoesNotExist(relativePath: string): RespInfo {
		/* __GDPR__
			"server.pageDoesNotExist" : {}
		*/
		this._reporter.sendTelemetryEvent('server.pageDoesNotExist');
		const fileNotFound = localize('fileNotFound', 'File not found');
		const relativePathFormatted = `<b>"${relativePath}"</b>`;
		const fileNotFoundMsg = localize(
			'fileNotFoundMsg',
			'The file {0} cannot be found. It may have been moved, edited, or deleted.',
			relativePathFormatted
		);
		const htmlString = `
		<!DOCTYPE html>
		<html>
			<head>
				<title>${fileNotFound}</title>
			</head>
			<body>
				<h1>${fileNotFound}</h1>
				<p>${fileNotFoundMsg}</p>
			</body>
			${this._scriptInjection}
		</html>
		`;

		return {
			Stream: Stream.Readable.from(htmlString),
			ContentType: 'text/html; charset=UTF-8',
		};
	}

	/**
	 * @description In a multi-root case, the index will not lead to anything. Create this page to list all possible indices to visit.
	 * @returns {RespInfo} the response info
	 */
	public createNoRootServer(): RespInfo {
		let customMsg;
		const noServerRoot = localize('noServerRoot', 'No Server Root');
		if (this._workspaceManager.numPaths == 0) {
			const noWorkspaceOpen = localize(
				'noWorkspaceOpen',
				'You have no workspace open, so the index does not direct to anything.'
			);
			customMsg = `<p>${noWorkspaceOpen}</p>`;
		} else {
			const multiRoot = localize(
				'multiRootOpen',
				'You are in a multi-root workspace, so the index does not lead to one specific workspace. Access your workspaces using the links below:'
			);
			customMsg = `<p>${multiRoot}</p>
			<ul>
			`;

			const workspaces = this._workspaceManager.workspaces;
			if (workspaces) {
				for (const i in workspaces) {
					const workspacePath = this._endpointManager.encodeLooseFileEndpoint(
						workspaces[i].uri.fsPath
					);
					customMsg += `
					<li><a href="${workspacePath}/">${workspaces[i].name}</a></li>`;
				}
			}
			customMsg += `</ul>`;
		}
		const htmlString = `
		<!DOCTYPE html>
		<html>
			<head>
				<title>${noServerRoot}</title>
			</head>
			<body>
				<h1>${noServerRoot}</h1>
				${customMsg}
			</body>
			${this._scriptInjection}
		</html>
		`;

		return {
			Stream: Stream.Readable.from(htmlString),
			ContentType: 'text/html; charset=UTF-8',
		};
	}

	/**
	 * @description Create a defaut index page (served if no `index.html` file is available for the directory).
	 * @param {string} readPath the absolute path visited.
	 * @param {string} relativePath the relative path (from workspace root).
	 * @param {string} titlePath the path shown in the title.
	 * @returns {RespInfo} the response info.
	 */
	public createIndexPage(
		readPath: string,
		relativePath: string,
		titlePath = relativePath
	): RespInfo {
		/* __GDPR__
			"server.indexPage" : {}
		*/
		this._reporter.sendTelemetryEvent('server.indexPage');

		const childFiles = fs.readdirSync(readPath);

		const fileEntries = new Array<IndexFileEntry>();
		const dirEntries = new Array<IndexDirEntry>();

		if (relativePath != '/') {
			dirEntries.push({ LinkSrc: '..', LinkName: '..', DateTime: '' });
		}

		for (const i in childFiles) {
			const relativeFileWithChild = path.join(relativePath, childFiles[i]);
			const absolutePath = path.join(readPath, childFiles[i]);

			const fileStats = fs.statSync(absolutePath);
			const modifiedDateTimeString = FormatDateTime(fileStats.mtime);

			if (fileStats.isDirectory()) {
				dirEntries.push({
					LinkSrc: relativeFileWithChild,
					LinkName: childFiles[i],
					DateTime: modifiedDateTimeString,
				});
			} else {
				const fileSize = FormatFileSize(fileStats.size);
				fileEntries.push({
					LinkSrc: relativeFileWithChild,
					LinkName: childFiles[i],
					FileSize: fileSize,
					DateTime: modifiedDateTimeString,
				});
			}
		}

		let directoryContents = '';

		dirEntries.forEach(
			(elem: IndexDirEntry) =>
				(directoryContents += `
				<tr>
				<td><a href="${elem.LinkSrc}/">${elem.LinkName}/</a></td>
				<td></td>
				<td>${elem.DateTime}</td>
				</tr>\n`)
		);

		fileEntries.forEach(
			(elem: IndexFileEntry) =>
				(directoryContents += `
				<tr>
				<td><a href="${elem.LinkSrc}">${elem.LinkName}</a></td>
				<td>${elem.FileSize}</td>
				<td>${elem.DateTime}</td>
				</tr>\n`)
		);

		const indexOfTitlePath = localize(
			'indexOfTitlePath',
			'Index of {0}',
			titlePath
		);
		const name = localize('name', 'Name');
		const size = localize('size', 'Size');
		const dateModified = localize('dateModified', 'Date Modified');
		const htmlString = `
		<!DOCTYPE html>
		<html>
			<head>
				<style>
					table td {
						padding:4px;
					}
				</style>
				<title>${indexOfTitlePath}</title>
			</head>
			<body>
			<h1>${indexOfTitlePath}</h1>

			<table>
				<th>${name}</th><th>${size}</th><th>${dateModified}</th>
				${directoryContents}
			</table>
			</body>

			${this._scriptInjection}
		</html>
		`;

		return {
			Stream: Stream.Readable.from(htmlString),
			ContentType: 'text/html; charset=UTF-8',
		};
	}

	/**
	 * @description get the file contents and load it into a form that can be served.
	 * @param {string} readPath the absolute file path to read from
	 * @param {boolean} inFilesystem whether the path is in the filesystem (false for untitled files in editor)
	 * @returns {RespInfo} the response info
	 */
	public getFileStream(readPath: string, inFilesystem = true): RespInfo {
		this._servedFiles.add(readPath);
		const workspaceDocuments = vscode.workspace.textDocuments;
		let i = 0;
		let stream;

		let contentType = mime.getType(readPath) ?? 'text/plain';

		while (i < workspaceDocuments.length) {
			if (PathUtil.PathEquals(readPath, workspaceDocuments[i].fileName)) {
				if (inFilesystem && workspaceDocuments[i].isUntitled) {
					continue;
				}
				let fileContents = workspaceDocuments[i].getText();

				if (workspaceDocuments[i].languageId == 'html') {
					fileContents = this.injectIntoFile(fileContents);
					contentType = 'text/html';
				}

				stream = Stream.Readable.from(fileContents);
				break;
			}
			i++;
		}

		if (inFilesystem && i == workspaceDocuments.length) {
			if (isFileInjectable(readPath)) {
				const buffer = fs.readFileSync(readPath, 'utf8');
				const injectedFileContents = this.injectIntoFile(buffer.toString());
				stream = Stream.Readable.from(injectedFileContents);
			} else {
				stream = fs.createReadStream(readPath);
			}
		}

		if (contentType.startsWith('text/')) {
			contentType = `${contentType}; charset=UTF-8`;
		}

		return {
			Stream: stream,
			ContentType: contentType,
		};
	}

	/**
	 * Inject the script tags to reference the custom Live Preview script.
	 * NOTE: they are injected on the same line as existing content to ensure that
	 * the debugging works, since `js-debug` relies on the line numbers on the filesystem
	 * matching the served line numbers.
	 * @param {string} contents the contents to inject.
	 * @returns {string} the injected string.
	 */
	private injectIntoFile(contents: string): string {
		// order of preference for script placement:
		// 1. after <head>
		// 2. after <body>
		// 3. after <html>
		// 4. after <!DOCTYPE >
		// 5. at the very beginning

		let re;
		let tagEnd = 0;
		for (const i in this._insertionTags) {
			re = new RegExp(`<${this._insertionTags[i]}[^>]*>`, 'g');
			re.test(contents);

			tagEnd = re.lastIndex;
			if (tagEnd != 0) {
				break;
			}
		}

		const newContents =
			contents.substr(0, tagEnd) +
			'\n' +
			this._scriptInjection +
			contents.substr(tagEnd);
		return newContents;
	}
}

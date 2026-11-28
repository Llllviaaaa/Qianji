/**
 * TypeScript declarations for `@novnc/novnc` (`core/rfb.js`).
 */
declare module "@novnc/novnc" {
  export interface RFBCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export interface RFBOptions {
    shared?: boolean;
    credentials?: RFBCredentials;
    repeaterID?: string;
    wsProtocols?: string | string[];
  }

  export interface RFBClipboardEventDetail {
    text: string;
  }

  export interface RFBDisconnectEventDetail {
    clean: boolean;
  }

  export default class RFB {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions);

    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;

    disconnect(): void;
    sendCredentials(credentials: RFBCredentials): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    sendCtrlAltDel(): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    clipboardPasteFrom(text: string): void;

    addEventListener(type: "connect", listener: (event: CustomEvent<undefined>) => void): void;
    addEventListener(type: "disconnect", listener: (event: CustomEvent<RFBDisconnectEventDetail>) => void): void;
    addEventListener(type: "clipboard", listener: (event: CustomEvent<RFBClipboardEventDetail>) => void): void;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  }
}

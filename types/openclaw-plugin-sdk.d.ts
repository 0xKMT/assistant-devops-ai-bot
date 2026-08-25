/**
 * Minimal OpenClaw SDK surface consumed by Friday plugins.
 * Keep this shim narrow and revalidate it whenever the pinned OpenClaw runtime
 * changes; it is not intended to model the entire upstream SDK.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface SlackInteractiveView {
    readonly callbackId?: string;
    readonly privateMetadata?: string;
    readonly state?: Record<string, unknown>;
  }

  export interface SlackInteractiveInteraction {
    readonly kind?: "button" | "select" | "view_submission" | "view_closed";
    readonly actionId?: string;
    readonly callbackId?: string;
    readonly data?: string;
    readonly value?: string;
    readonly triggerId?: string;
    readonly stateValues?: Record<string, unknown>;
  }

  export interface SlackInteractiveContext {
    readonly actionId?: string;
    readonly data?: string;
    readonly triggerId?: string;
    readonly senderId?: string;
    readonly accountId?: string;
    readonly conversationId?: string;
    readonly threadId?: string;
    readonly workspaceId?: string;
    readonly channelId?: string;
    readonly threadTs?: string;
    readonly view?: SlackInteractiveView;
    readonly interaction?: SlackInteractiveInteraction;
    readonly auth: { readonly isAuthorizedSender: boolean };
    readonly respond: {
      acknowledge(): void | Promise<void>;
      ephemeral?(text: string): void | Promise<void>;
      reply?(payload: { readonly text: string; readonly responseType?: "ephemeral" | "in_channel" }): void | Promise<void>;
    };
  }

  export interface OpenClawPluginApi {
    readonly config: any;
    readonly pluginConfig?: Record<string, unknown>;
    readonly runtime: any;
    readonly logger: {
      info(message: string): void;
      warn(message: string): void;
      error(message: string): void;
    };
    registerTool<TParams>(
      tool: {
        name: string;
        description: string;
        parameters: object;
        execute(id: string, params: TParams): Promise<unknown>;
      } | ((context: OpenClawPluginToolContext) => {
        name: string;
        description: string;
        parameters: object;
        execute(id: string, params: TParams): Promise<unknown>;
      }),
      options?: { name?: string; names?: string[]; optional?: boolean },
    ): void;
    registerInteractiveHandler(registration: {
      readonly channel: "slack";
      readonly namespace: "friday-jira";
      readonly handler: (context: SlackInteractiveContext) => { handled: true } | Promise<{ handled: true }>;
    }): void;
    on(event: string, handler: (...args: any[]) => any, options?: object): void;
  }

  export interface OpenClawPluginToolContext {
    readonly sessionKey?: string;
    readonly messageChannel?: string;
    readonly requesterSenderId?: string;
    readonly deliveryContext?: {
      readonly channel?: string;
      readonly to?: string;
      readonly accountId?: string;
      readonly threadId?: string | number;
    };
  }

  export interface OpenClawPluginDefinition {
    id: string;
    name: string;
    description: string;
    register(api: OpenClawPluginApi): void;
  }

  export function definePluginEntry(definition: OpenClawPluginDefinition): OpenClawPluginDefinition;
}

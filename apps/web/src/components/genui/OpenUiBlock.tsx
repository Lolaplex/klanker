import { useMemo, useState } from "react";
import { Renderer } from "@openuidev/react-lang";
import type { ActionEvent, OpenUIError } from "@openuidev/react-lang";
import { openuiChatLibrary } from "@openuidev/react-ui/genui-lib";
import { DotMatrixLoader } from "@openuidev/react-ui/DotMatrixLoader";
import { dispatchOpenUiAction, type OpenUiActionContext } from "./actionDispatcher";
import { unsafeOpenUiReason } from "./safety";
import { OpenUiRawFallback } from "./OpenUiRawFallback";

export type OpenUiBlockProps = {
  source: string;
  streaming?: boolean;
  actionContext: OpenUiActionContext;
};

function errorKey(errors: OpenUIError[]): string {
  return errors.map((e) => `${e.code}:${e.message}:${e.severity || ""}`).join("\n");
}

/**
 * Lazy GenUI island. openuiChatLibrary is already the chat-curated catalog —
 * no raw HTML/script/iframe component exists in it — and the safety gate above
 * refuses executable schemes before the DSL reaches the runtime.
 */
export default function OpenUiBlock({ source, streaming = false, actionContext }: OpenUiBlockProps) {
  const [errors, setErrors] = useState<OpenUIError[]>([]);
  const unsafeReason = useMemo(() => unsafeOpenUiReason(source), [source]);

  if (unsafeReason) return <OpenUiRawFallback source={source} reason={unsafeReason} />;

  const fatal = errors.filter((e) => e.severity !== "warning");
  if (!streaming && fatal.length) {
    return <OpenUiRawFallback source={source} reason={fatal[0].message || fatal[0].code || "parse error"} />;
  }

  return (
    <div className="klanker-genui my-2 min-w-0 overflow-hidden rounded-md border border-subtle bg-surface text-ink-primary" data-testid="openui-block">
      <Renderer
        response={source}
        library={openuiChatLibrary}
        isStreaming={streaming}
        queryLoader={
          <div className="flex items-center justify-center p-4 text-ink-muted">
            <DotMatrixLoader variant="compact" size={28} />
          </div>
        }
        onAction={(event: ActionEvent) => {
          dispatchOpenUiAction(
            {
              type: String(event.type || ""),
              params: event.params || {},
              humanFriendlyMessage: event.humanFriendlyMessage,
              formState: event.formState,
              formName: event.formName,
            },
            actionContext
          );
        }}
        onError={(next) => {
          setErrors((prev) => (errorKey(prev) === errorKey(next) ? prev : next));
        }}
      />
    </div>
  );
}

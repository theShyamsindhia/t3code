import type { OrchestrationV2ProviderRetry } from "@t3tools/contracts";

export function ProviderConnectionErrorDetails({
  description,
  message,
  retry,
}: {
  description: string;
  message: string;
  retry?: OrchestrationV2ProviderRetry | undefined;
}) {
  return (
    <div className="space-y-1">
      <p>{description}</p>
      <details>
        <summary className="cursor-pointer text-xs underline-offset-4 hover:underline">
          Technical details
        </summary>
        <p className="mt-1 whitespace-pre-wrap break-words text-xs">{message}</p>
        {retry ? (
          <p className="mt-1 text-xs">
            Retries: {retry.attempt}
            {retry.maxAttempts === null ? "" : `/${retry.maxAttempts}`}
          </p>
        ) : null}
      </details>
    </div>
  );
}

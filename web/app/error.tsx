"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";
import Link from "next/link";

export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}): React.JSX.Element {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-xl py-16 text-center">
      <h1 className="text-2xl font-semibold text-fg">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted">
        The page could not be rendered. If the database is not running, start it with{" "}
        <code className="font-mono text-fg">docker compose up -d</code> at the project root.
      </p>
      {error.digest ? (
        <p className="mt-2 font-mono text-xs text-muted">digest {error.digest}</p>
      ) : null}
      <div className="mt-6 flex justify-center gap-3">
        <button
          type="button"
          onClick={() => retry()}
          className="rounded border border-accent px-3 py-1.5 text-sm text-accent hover:bg-accent/10"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded border border-grid px-3 py-1.5 text-sm text-fg hover:border-muted"
        >
          Home
        </Link>
      </div>
    </div>
  );
}

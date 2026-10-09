'use client';
import { useEffect } from 'react';

// A Client Component: it must not import the logger. It posts to the route handler instead.
export default function Error({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    void fetch('/api/client-error', {
      method: 'POST',
      body: JSON.stringify({ message: error.message, stack: error.stack, digest: error.digest }),
    });
  }, [error]);
  return <p>Something went wrong.</p>;
}

"use client";

import { useState } from "react";
import { Button } from "@/components/button";

export function ThrowErrorButton() {
  const [shouldThrow, setShouldThrow] = useState(false);

  // Throwing during render (not in the click handler) is what error boundaries catch.
  if (shouldThrow) {
    throw new Error("Example error from ThrowErrorButton");
  }

  return <Button onClick={() => setShouldThrow(true)}>Throw an error</Button>;
}

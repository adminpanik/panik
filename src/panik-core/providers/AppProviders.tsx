/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { exitWagmiConfig } from "../lib/exit";

/**
 * AppProviders - the infrastructure boundary for the isolated product app.
 *
 * Mounts wagmi + react-query for the Atomic Exit / Open Position transaction
 * flows (Phase 2). Keeping all of it here (rather than in the landing bundle)
 * is what makes the app a separate, hardened security surface: the landing
 * page never imports any of these providers.
 */
const queryClient = new QueryClient();

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={exitWagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}

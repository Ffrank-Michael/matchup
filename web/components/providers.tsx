"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";

import { GoogleWalletProvider } from "@/lib/use-google-wallet";
import { config } from "@/lib/wagmi";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(() => new QueryClient());
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <GoogleWalletProvider>{children}</GoogleWalletProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

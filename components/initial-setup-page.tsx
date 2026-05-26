import { OnboardingPanel } from "@/components/onboarding-panel";

export function InitialSetupPage() {
  return (
    <main className="mx-auto max-w-5xl w-full px-4 py-8">
      <h1 className="mb-6 text-3xl font-bold">Initial Setup</h1>
      <OnboardingPanel alwaysOpen />
    </main>
  );
}

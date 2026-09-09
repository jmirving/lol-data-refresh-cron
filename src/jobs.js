// Runtime configuration is injected here at the process boundary. Future job
// registrations should resolve their adapter options from this argument.
export function createJobs(runtimeProfile) {
  void runtimeProfile;
  return [];
}

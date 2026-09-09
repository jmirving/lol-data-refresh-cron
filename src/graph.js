export class JobGraphError extends Error {
  constructor(message) {
    super(message);
    this.name = "JobGraphError";
  }
}

function insertSorted(items, value) {
  const index = items.findIndex((item) => item > value);
  if (index === -1) items.push(value);
  else items.splice(index, 0, value);
}

export function resolveExecutionOrder(jobs) {
  const byId = new Map();
  for (const job of jobs) {
    if (byId.has(job.id)) {
      throw new JobGraphError(`duplicate job ID: ${job.id}`);
    }
    byId.set(job.id, job);
  }

  for (const job of jobs) {
    for (const dependencyId of job.dependencies) {
      if (!byId.has(dependencyId)) {
        throw new JobGraphError(`job ${job.id} has unknown dependency: ${dependencyId}`);
      }
    }
  }

  const remainingDependencies = new Map();
  const dependents = new Map([...byId.keys()].map((id) => [id, []]));
  for (const job of jobs) {
    remainingDependencies.set(job.id, job.dependencies.length);
    for (const dependencyId of job.dependencies) {
      dependents.get(dependencyId).push(job.id);
    }
  }
  for (const ids of dependents.values()) ids.sort();

  const ready = [...byId.keys()]
    .filter((id) => remainingDependencies.get(id) === 0)
    .sort();
  const order = [];

  while (ready.length > 0) {
    const id = ready.shift();
    order.push(byId.get(id));
    for (const dependentId of dependents.get(id)) {
      const remaining = remainingDependencies.get(dependentId) - 1;
      remainingDependencies.set(dependentId, remaining);
      if (remaining === 0) insertSorted(ready, dependentId);
    }
  }

  if (order.length !== jobs.length) {
    const cycleMembers = [...byId.keys()]
      .filter((id) => remainingDependencies.get(id) > 0)
      .sort();
    throw new JobGraphError(`dependency cycle detected among jobs: ${cycleMembers.join(", ")}`);
  }

  return order;
}

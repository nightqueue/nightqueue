// Target of a registered project row (as the registry answers it): the project and the org it belongs to.
export function projectTargetOf(project) {
  return {
    scope: "project",
    projectId: project.id,
    orgId: project.org_id ?? null,
    project: project.name,
    org: project.org ?? null,
    key: project.key ?? null,
  };
}

// Target of a registered org row.
export function orgTargetOf(org) {
  return { scope: "org", projectId: null, orgId: org.id, project: null, org: org.name, key: org.key ?? null };
}

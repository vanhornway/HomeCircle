import type { CircleClient } from '@homecircle/core';

/** Which parts of the Lists tab a circle has: they need its helper, and each feature on. */
export function listsOf(client: CircleClient) {
  const helper = !!client.agent;
  return {
    shopping: helper && client.feature('shoppingLists'),
    reminders: helper && client.feature('reminders'),
    memory: helper && client.feature('agent'),
  };
}

export const helperHasLists = (client: CircleClient) => Object.values(listsOf(client)).some(Boolean);

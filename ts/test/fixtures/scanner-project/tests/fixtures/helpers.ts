export const makeUser = (name: string) => ({ name });

export function seedDatabase() {
  return true;
}

export class TestHarness {
  reset() {}
}

const internalThing = 1;
export { internalThing as publicThing };

/**
 * A money-handling UI with no test runner is a gap. This one is deliberately
 * small: jsdom plus ts-jest, for the framework-free logic that is worth pinning
 * — redirect validation, the fils keypad, business-day placement. Component
 * rendering is not covered here and would need @testing-library/react.
 */
module.exports = {
  testEnvironment: 'jsdom',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)sx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx' } }] },
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
};

import js from '@eslint/js';
import globals from 'globals';

/* 项目风格规则的工具化落点（编码规范 CS 的机器可查部分）：
 * - curly / eqeqeq / no-var / prefer-const：基础写法纪律
 * - complexity / max-depth / max-lines-per-function：CS-10（函数 ≤40 行、嵌套 ≤3 层、圈复杂度 ≤10）
 * 存量基线：规则引入时对全仓实测仅 2 条违例（storage.js / log.js 的死赋值），已与工具链同一提交修复清零；此后新增违例一律拦截。
 * 未启用 no-magic-numbers：项目判据是「出现 ≥2 次或语义不显然」，与规则语义不符（会大量误报常数字面量）——判据留给评审执行。 */
const STYLE_RULES = {
  curly: ['error', 'all'],
  eqeqeq: ['error', 'always'],
  'no-var': 'error',
  'prefer-const': 'error',
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
  complexity: ['error', { max: 10 }],
  'max-depth': ['error', { max: 3 }],
  'max-lines-per-function': ['error', { max: 40, skipComments: true, skipBlankLines: true }],
};

export default [
  js.configs.recommended,
  {
    ignores: ['node_modules/**', 'poc/**'],
  },
  {
    // 产品代码：stdout 是 stdio MCP 的协议通道——只放行实测写 stderr 的 console 方法
    files: ['src/**/*.js', 'bin/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.node },
    rules: {
      ...STYLE_RULES,
      'no-console': ['error', { allow: ['error', 'warn', 'trace', 'assert'] }],
    },
  },
  {
    // 测试与夹具：允许写 stdout（夹具以 stdout 承载自有命令行协议），其余规则一致
    files: ['test/**/*.js', 'test/**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.node },
    rules: { ...STYLE_RULES, 'no-console': 'off' },
  },
];

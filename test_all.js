/**
 * Comprehensive test suite for JSON Architect Agent backend.
 * Tests all query operations (group, filter, sort, select, count, unique)
 * against multi-level nested JSON objects.
 *
 * Usage: node test_all.js
 * Requires the server running on localhost:5000
 */

const BASE = 'http://localhost:5000/api/convert';

// ─────────────────────────────────────────────
// MULTI-LEVEL TEST DATA
// ─────────────────────────────────────────────

const companyData = {
  company: {
    name: "TechCorp",
    founded: 2010,
    departments: [
      {
        deptId: "D1",
        name: "Engineering",
        budget: 500000,
        teams: [
          {
            teamId: "T1",
            name: "Backend",
            employees: [
              { empId: "E1", name: "Alice", role: "Senior Dev", salary: 120000, skills: ["Node.js", "Python"] },
              { empId: "E2", name: "Bob", role: "Junior Dev", salary: 75000, skills: ["Node.js"] },
              { empId: "E3", name: "Charlie", role: "Senior Dev", salary: 130000, skills: ["Go", "Rust"] }
            ]
          },
          {
            teamId: "T2",
            name: "Frontend",
            employees: [
              { empId: "E4", name: "Diana", role: "Lead Dev", salary: 140000, skills: ["React", "TypeScript"] },
              { empId: "E5", name: "Eve", role: "Junior Dev", salary: 70000, skills: ["React"] }
            ]
          }
        ]
      },
      {
        deptId: "D2",
        name: "Marketing",
        budget: 300000,
        teams: [
          {
            teamId: "T3",
            name: "Digital",
            employees: [
              { empId: "E6", name: "Frank", role: "Manager", salary: 110000, skills: ["SEO", "Analytics"] },
              { empId: "E7", name: "Grace", role: "Specialist", salary: 85000, skills: ["Content", "SEO"] }
            ]
          }
        ]
      },
      {
        deptId: "D3",
        name: "Sales",
        budget: 250000,
        teams: [
          {
            teamId: "T4",
            name: "Enterprise",
            employees: [
              { empId: "E8", name: "Hank", role: "Senior Dev", salary: 105000, skills: ["CRM"] },
              { empId: "E9", name: "Ivy", role: "Junior Dev", salary: 65000, skills: ["Communication"] }
            ]
          }
        ]
      }
    ]
  }
};

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

async function sendRequest(prompt, data = companyData) {
  const formData = new FormData();
  formData.append('prompt', prompt);
  formData.append('jsonInputs', JSON.stringify([
    { name: 'Source 1', content: JSON.stringify(data) }
  ]));

  const res = await fetch(BASE, { method: 'POST', body: formData });
  const json = await res.json();
  return { status: res.status, body: json };
}

let passed = 0;
let failed = 0;
const failures = [];

function assert(testName, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✅ ${testName}`);
  } else {
    failed++;
    failures.push({ testName, detail });
    console.log(`  ❌ ${testName}${detail ? ' — ' + detail : ''}`);
  }
}

// ─────────────────────────────────────────────
// TEST 1: GROUP BY
// ─────────────────────────────────────────────
async function testGroupBy() {
  console.log('\n── TEST: Group employees by role ──');
  const { status, body } = await sendRequest('group employees by role');

  assert('Status 200', status === 200, `got ${status}`);
  assert('Mode is dynamic_group', body.mode === 'dynamic_group', `got mode=${body.mode}`);

  const groups = body.results?.[0]?.groups || body.query?.groups || {};
  const groupKeys = Object.keys(groups);

  assert('Has groups object', groupKeys.length > 0, `keys: ${JSON.stringify(groupKeys)}`);
  assert('Has "Senior Dev" group', 'Senior Dev' in groups, `keys: ${JSON.stringify(groupKeys)}`);
  assert('Has "Junior Dev" group', 'Junior Dev' in groups, `keys: ${JSON.stringify(groupKeys)}`);

  if (groups['Senior Dev']) {
    assert('Senior Dev count = 3', groups['Senior Dev'].length === 3,
      `got ${groups['Senior Dev'].length}: ${groups['Senior Dev'].map(e => e.name).join(', ')}`);
  }
  if (groups['Junior Dev']) {
    assert('Junior Dev count = 3', groups['Junior Dev'].length === 3,
      `got ${groups['Junior Dev'].length}: ${groups['Junior Dev'].map(e => e.name).join(', ')}`);
  }
}

// ─────────────────────────────────────────────
// TEST 2: FILTER
// ─────────────────────────────────────────────
async function testFilter() {
  console.log('\n── TEST: Filter employees where role is Senior Dev ──');
  const { status, body } = await sendRequest('filter employees where role is Senior Dev');

  assert('Status 200', status === 200, `got ${status}`);
  assert('Mode is dynamic_filter', body.mode === 'dynamic_filter', `got mode=${body.mode}`);

  const results = body.results?.[0]?.results || [];
  const names = results.map(r => (r.data || r).name);

  assert('Found 3 Senior Devs', results.length === 3, `got ${results.length}: ${JSON.stringify(names)}`);
  assert('Includes Alice', names.includes('Alice'), `names: ${JSON.stringify(names)}`);
  assert('Includes Charlie', names.includes('Charlie'), `names: ${JSON.stringify(names)}`);
  assert('Includes Hank', names.includes('Hank'), `names: ${JSON.stringify(names)}`);
}

// ─────────────────────────────────────────────
// TEST 3: SORT ASCENDING
// ─────────────────────────────────────────────
async function testSortAsc() {
  console.log('\n── TEST: Sort employees by name ascending ──');
  const { status, body } = await sendRequest('sort employees by name ascending');

  assert('Status 200', status === 200, `got ${status}`);
  assert('Mode is dynamic_sort', body.mode === 'dynamic_sort', `got mode=${body.mode}`);

  const results = body.results?.[0]?.results || [];
  const names = results.map(r => r.name);

  assert('Got 9 employees', results.length === 9, `got ${results.length}`);
  assert('First is Alice', names[0] === 'Alice', `first: ${names[0]}`);
  assert('Last is Ivy', names[names.length - 1] === 'Ivy', `last: ${names[names.length - 1]}`);

  // Verify sort order
  const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  assert('Correctly sorted A-Z', JSON.stringify(names) === JSON.stringify(sorted),
    `got: ${JSON.stringify(names)}`);
}

// ─────────────────────────────────────────────
// TEST 4: SORT DESCENDING
// ─────────────────────────────────────────────
async function testSortDesc() {
  console.log('\n── TEST: Sort employees by salary descending ──');
  const { status, body } = await sendRequest('sort employees by salary descending');

  assert('Status 200', status === 200, `got ${status}`);

  const results = body.results?.[0]?.results || [];
  const salaries = results.map(r => r.salary);

  assert('Got 9 employees', results.length === 9, `got ${results.length}`);
  assert('First salary is highest (140000)', salaries[0] === 140000, `first: ${salaries[0]}`);
  assert('Last salary is lowest (65000)', salaries[salaries.length - 1] === 65000, `last: ${salaries[salaries.length - 1]}`);

  // Verify descending order
  const isDescending = salaries.every((v, i) => i === 0 || v <= salaries[i - 1]);
  assert('Correctly sorted high-to-low', isDescending, `salaries: ${JSON.stringify(salaries)}`);
}

// ─────────────────────────────────────────────
// TEST 5: SELECT FIELDS
// ─────────────────────────────────────────────
async function testSelect() {
  console.log('\n── TEST: Select name, salary from employees ──');
  const { status, body } = await sendRequest('select name, salary from employees');

  assert('Status 200', status === 200, `got ${status}`);
  assert('Mode is dynamic_select', body.mode === 'dynamic_select', `got mode=${body.mode}`);

  const results = body.results?.[0]?.results || [];

  assert('Got 9 employees', results.length === 9, `got ${results.length}`);

  if (results.length > 0) {
    const keys = Object.keys(results[0]);
    assert('Only name and salary fields', keys.length === 2 && keys.includes('name') && keys.includes('salary'),
      `keys: ${JSON.stringify(keys)}`);
    assert('No empId leaked', !('empId' in results[0]), `has empId`);
    assert('No role leaked', !('role' in results[0]), `has role`);
  }
}

// ─────────────────────────────────────────────
// TEST 6: COUNT BY FIELD
// ─────────────────────────────────────────────
async function testCount() {
  console.log('\n── TEST: Count employees by role ──');
  const { status, body } = await sendRequest('count employees by role');

  assert('Status 200', status === 200, `got ${status}`);
  assert('Mode is dynamic_count', body.mode === 'dynamic_count', `got mode=${body.mode}`);

  const counts = body.results?.[0]?.counts || {};

  assert('Has counts object', Object.keys(counts).length > 0, `keys: ${JSON.stringify(Object.keys(counts))}`);
  assert('Senior Dev = 3', counts['Senior Dev'] === 3, `got ${counts['Senior Dev']}`);
  assert('Junior Dev = 3', counts['Junior Dev'] === 3, `got ${counts['Junior Dev']}`);
  assert('Lead Dev = 1', counts['Lead Dev'] === 1, `got ${counts['Lead Dev']}`);
  assert('Manager = 1', counts['Manager'] === 1, `got ${counts['Manager']}`);
  assert('Specialist = 1', counts['Specialist'] === 1, `got ${counts['Specialist']}`);
}

// ─────────────────────────────────────────────
// TEST 7: UNIQUE VALUES
// ─────────────────────────────────────────────
async function testUnique() {
  console.log('\n── TEST: Unique role from employees ──');
  const { status, body } = await sendRequest('unique role from employees');

  assert('Status 200', status === 200, `got ${status}`);
  assert('Mode is dynamic_unique', body.mode === 'dynamic_unique', `got mode=${body.mode}`);

  const values = body.results?.[0]?.values || [];

  assert('Got 5 unique roles', values.length === 5, `got ${values.length}: ${JSON.stringify(values)}`);
  assert('Includes Senior Dev', values.includes('Senior Dev'), JSON.stringify(values));
  assert('Includes Junior Dev', values.includes('Junior Dev'), JSON.stringify(values));
  assert('Includes Lead Dev', values.includes('Lead Dev'), JSON.stringify(values));
  assert('Includes Manager', values.includes('Manager'), JSON.stringify(values));
  assert('Includes Specialist', values.includes('Specialist'), JSON.stringify(values));
}

// ─────────────────────────────────────────────
// TEST 8: GROUP WITH EXCLUSION
// ─────────────────────────────────────────────
async function testGroupWithExclude() {
  console.log('\n── TEST: Group employees by role without salary, skills ──');
  const { status, body } = await sendRequest('group employees by role without salary, skills');

  assert('Status 200', status === 200, `got ${status}`);

  const groups = body.results?.[0]?.groups || {};
  const firstGroup = Object.values(groups)[0] || [];

  assert('Has groups', Object.keys(groups).length > 0, `empty groups`);

  if (firstGroup.length > 0) {
    const item = firstGroup[0];
    assert('salary excluded', !('salary' in item), `salary present: ${item.salary}`);
    assert('skills excluded', !('skills' in item), `skills present`);
    assert('name still present', 'name' in item, `name missing`);
  }
}

// ─────────────────────────────────────────────
// TEST 9: FILTER WITH EXCLUSION
// ─────────────────────────────────────────────
async function testFilterWithExclude() {
  console.log('\n── TEST: Filter employees where role is Manager without empId ──');
  const { status, body } = await sendRequest('filter employees where role is Manager without empId');

  assert('Status 200', status === 200, `got ${status}`);

  const results = body.results?.[0]?.results || [];

  assert('Found 1 Manager', results.length === 1, `got ${results.length}`);

  if (results.length > 0) {
    const item = results[0].data || results[0];
    assert('Is Frank', item.name === 'Frank', `got ${item.name}`);
    assert('empId excluded', !('empId' in item), `empId present: ${item.empId}`);
  }
}

// ─────────────────────────────────────────────
// TEST 10: DEEPER NESTING — Group teams by name
// ─────────────────────────────────────────────
async function testDeepNesting() {
  console.log('\n── TEST: Count teams by name (deeper collection) ──');
  const { status, body } = await sendRequest('count teams by name');

  assert('Status 200', status === 200, `got ${status}`);

  const counts = body.results?.[0]?.counts || {};

  assert('Has counts', Object.keys(counts).length > 0, `empty counts`);
  assert('Backend = 1', counts['Backend'] === 1, `got ${counts['Backend']}`);
  assert('Frontend = 1', counts['Frontend'] === 1, `got ${counts['Frontend']}`);
  assert('Digital = 1', counts['Digital'] === 1, `got ${counts['Digital']}`);
  assert('Enterprise = 1', counts['Enterprise'] === 1, `got ${counts['Enterprise']}`);
}

// ─────────────────────────────────────────────
// TEST 11: MULTI-OP — group + count in one prompt
// ─────────────────────────────────────────────
async function testMultiOp() {
  console.log('\n── TEST: Multi-operation (group + count) ──');
  const { status, body } = await sendRequest(
    'group employees by role and count departments by name'
  );

  assert('Status 200', status === 200, `got ${status}`);

  // Could be multi_operation or single depending on parsing
  if (body.mode === 'multi_operation') {
    assert('Has operations array', Array.isArray(body.operations), 'missing operations');
    assert('Has 2 operations', body.operations.length === 2, `got ${body.operations.length}`);
  } else {
    // At minimum the first operation should work
    assert('At least one operation executed', body.mode?.startsWith('dynamic_'), `mode: ${body.mode}`);
  }
}

// ─────────────────────────────────────────────
// TEST 12: Sort departments by budget
// ─────────────────────────────────────────────
async function testSortDepartments() {
  console.log('\n── TEST: Sort departments by budget descending ──');
  const { status, body } = await sendRequest('sort departments by budget descending');

  assert('Status 200', status === 200, `got ${status}`);

  const results = body.results?.[0]?.results || [];
  const budgets = results.map(r => r.budget);

  assert('Got 3 departments', results.length === 3, `got ${results.length}`);
  assert('First is Engineering (500000)', budgets[0] === 500000, `first: ${budgets[0]}`);
  assert('Last is Sales (250000)', budgets[budgets.length - 1] === 250000, `last: ${budgets[budgets.length - 1]}`);
}

// ─────────────────────────────────────────────
// TEST 13: Unique department names
// ─────────────────────────────────────────────
async function testUniqueDepts() {
  console.log('\n── TEST: Unique name from departments ──');
  const { status, body } = await sendRequest('unique name from departments');

  assert('Status 200', status === 200, `got ${status}`);

  const values = body.results?.[0]?.values || [];

  assert('Got 3 unique dept names', values.length === 3, `got ${values.length}: ${JSON.stringify(values)}`);
  assert('Includes Engineering', values.includes('Engineering'), JSON.stringify(values));
  assert('Includes Marketing', values.includes('Marketing'), JSON.stringify(values));
  assert('Includes Sales', values.includes('Sales'), JSON.stringify(values));
}

// ─────────────────────────────────────────────
// TEST 14: Select from deeper level
// ─────────────────────────────────────────────
async function testSelectDeep() {
  console.log('\n── TEST: Select empId, name from employees ──');
  const { status, body } = await sendRequest('select empId, name from employees');

  assert('Status 200', status === 200, `got ${status}`);

  const results = body.results?.[0]?.results || [];

  assert('Got 9 employees', results.length === 9, `got ${results.length}`);
  if (results.length > 0) {
    const keys = Object.keys(results[0]);
    assert('Only empId and name', keys.length === 2 && keys.includes('empId') && keys.includes('name'),
      `keys: ${JSON.stringify(keys)}`);
  }
}

// ─────────────────────────────────────────────
// MULTI-SOURCE TEST DATA (mirrors real UI usage)
// Source 1: Employees
// Source 2: Departments
// Source 3: Projects
// Source 4: Clients
// ─────────────────────────────────────────────

const employeeSource = {
  employees: [
    { empId: "EMP_101", name: "Alice", departmentId: "DEP_1", role: "Senior Dev", salary: 120000 },
    { empId: "EMP_102", name: "Bob",   departmentId: "DEP_1", role: "Junior Dev", salary: 75000 },
    { empId: "EMP_103", name: "Charlie", departmentId: "DEP_2", role: "Manager", salary: 110000 },
    { empId: "EMP_104", name: "Diana", departmentId: "DEP_2", role: "Lead Dev", salary: 140000 }
  ]
};

const departmentSource = {
  departments: [
    { deptId: "DEP_1", name: "Engineering", budget: 500000 },
    { deptId: "DEP_2", name: "Marketing",   budget: 300000 }
  ]
};

const projectSource = {
  projects: [
    { projectId: "PROJ_1", projectName: "CRM Rebuild", status: "Active",    clientId: "CLIENT_1", assignedEmpId: "EMP_101" },
    { projectId: "PROJ_2", projectName: "AI Chatbot",  status: "Completed", clientId: "CLIENT_2", assignedEmpId: "EMP_104" },
    { projectId: "PROJ_3", projectName: "Data Pipeline", status: "Active",  clientId: "CLIENT_1", assignedEmpId: "EMP_102" }
  ]
};

const clientSource = {
  clients: [
    { clientId: "CLIENT_1", clientName: "Amazon Pvt Ltd", country: "India" },
    { clientId: "CLIENT_2", clientName: "Google Labs",    country: "USA"   }
  ]
};

async function sendMultiRequest(prompt, sources) {
  const formData = new FormData();
  formData.append('prompt', prompt);
  formData.append('jsonInputs', JSON.stringify(
    sources.map((data, i) => ({ name: `Source ${i + 1}`, content: JSON.stringify(data) }))
  ));
  const res = await fetch(BASE, { method: 'POST', body: formData });
  const json = await res.json();
  return { status: res.status, body: json };
}

// ─────────────────────────────────────────────
// TEST 15: Multi-source — query @Source1 only
// ─────────────────────────────────────────────
async function testMultiSourceFilterS1() {
  console.log('\n── TEST: [Multi-Source] Filter employees where role is Senior Dev (@Source1) ──');
  const { status, body } = await sendMultiRequest(
    'filter employees where role is Senior Dev',
    [employeeSource, departmentSource, projectSource, clientSource]
  );

  assert('Status 200', status === 200, `got ${status}`);
  assert('Mode is dynamic_filter', body.mode === 'dynamic_filter', `mode: ${body.mode}`);

  const results = body.results?.[0]?.results || [];
  const names = results.map(r => (r.data || r).name);

  assert('Found 1 Senior Dev', results.length === 1, `got ${results.length}: ${JSON.stringify(names)}`);
  assert('Is Alice', names.includes('Alice'), JSON.stringify(names));
}

// ─────────────────────────────────────────────
// TEST 16: Multi-source — query @Source2 (departments)
// ─────────────────────────────────────────────
async function testMultiSourceFilterS2() {
  console.log('\n── TEST: [Multi-Source] Filter departments where name is Engineering (@Source2) ──');
  const { status, body } = await sendMultiRequest(
    'filter departments where name is Engineering',
    [employeeSource, departmentSource, projectSource, clientSource]
  );

  assert('Status 200', status === 200, `got ${status}`);

  const results = body.results?.[0]?.results || [];
  const item = results[0]?.data || results[0];

  assert('Found 1 department', results.length === 1, `got ${results.length}`);
  assert('Is Engineering', item?.name === 'Engineering', `got: ${item?.name}`);
  assert('Has budget', item?.budget === 500000, `budget: ${item?.budget}`);
}

// ─────────────────────────────────────────────
// TEST 17: Multi-source — group projects by status
// ─────────────────────────────────────────────
async function testMultiSourceGroupProjects() {
  console.log('\n── TEST: [Multi-Source] Group projects by status ──');
  const { status, body } = await sendMultiRequest(
    'group projects by status',
    [employeeSource, departmentSource, projectSource, clientSource]
  );

  assert('Status 200', status === 200, `got ${status}`);
  assert('Mode is dynamic_group', body.mode === 'dynamic_group', `mode: ${body.mode}`);

  const groups = body.results?.[0]?.groups || {};

  assert('Has groups', Object.keys(groups).length > 0, JSON.stringify(Object.keys(groups)));
  assert('Active = 2', groups['Active']?.length === 2, `got ${groups['Active']?.length}`);
  assert('Completed = 1', groups['Completed']?.length === 1, `got ${groups['Completed']?.length}`);
}

// ─────────────────────────────────────────────
// TEST 18: Multi-source — count employees by role
// ─────────────────────────────────────────────
async function testMultiSourceCount() {
  console.log('\n── TEST: [Multi-Source] Count employees by role ──');
  const { status, body } = await sendMultiRequest(
    'count employees by role',
    [employeeSource, departmentSource, projectSource, clientSource]
  );

  assert('Status 200', status === 200, `got ${status}`);
  assert('Mode is dynamic_count', body.mode === 'dynamic_count', `mode: ${body.mode}`);

  const counts = body.results?.[0]?.counts || {};

  assert('Senior Dev = 1', counts['Senior Dev'] === 1, `got ${counts['Senior Dev']}`);
  assert('Junior Dev = 1', counts['Junior Dev'] === 1, `got ${counts['Junior Dev']}`);
  assert('Manager = 1',    counts['Manager'] === 1,    `got ${counts['Manager']}`);
  assert('Lead Dev = 1',   counts['Lead Dev'] === 1,   `got ${counts['Lead Dev']}`);
}

// ─────────────────────────────────────────────
// TEST 19: Multi-source — unique countries from clients
// ─────────────────────────────────────────────
async function testMultiSourceUnique() {
  console.log('\n── TEST: [Multi-Source] Unique country from clients ──');
  const { status, body } = await sendMultiRequest(
    'unique country from clients',
    [employeeSource, departmentSource, projectSource, clientSource]
  );

  assert('Status 200', status === 200, `got ${status}`);
  assert('Mode is dynamic_unique', body.mode === 'dynamic_unique', `mode: ${body.mode}`);

  const values = body.results?.[0]?.values || [];

  assert('Got 2 unique countries', values.length === 2, `got ${values.length}: ${JSON.stringify(values)}`);
  assert('Includes India', values.includes('India'), JSON.stringify(values));
  assert('Includes USA',   values.includes('USA'),   JSON.stringify(values));
}

// ─────────────────────────────────────────────
// TEST 20: Multi-source — sort employees by salary descending
// ─────────────────────────────────────────────
async function testMultiSourceSort() {
  console.log('\n── TEST: [Multi-Source] Sort employees by salary descending ──');
  const { status, body } = await sendMultiRequest(
    'sort employees by salary descending',
    [employeeSource, departmentSource, projectSource, clientSource]
  );

  assert('Status 200', status === 200, `got ${status}`);
  assert('Mode is dynamic_sort', body.mode === 'dynamic_sort', `mode: ${body.mode}`);

  const results = body.results?.[0]?.results || [];
  const salaries = results.map(r => r.salary);

  assert('Got 4 employees', results.length === 4, `got ${results.length}`);
  assert('First is Diana (140000)', salaries[0] === 140000, `first: ${salaries[0]}`);
  assert('Last is Bob (75000)',     salaries[salaries.length - 1] === 75000, `last: ${salaries[salaries.length - 1]}`);

  const isDescending = salaries.every((v, i) => i === 0 || v <= salaries[i - 1]);
  assert('Correctly sorted high-to-low', isDescending, JSON.stringify(salaries));
}

// ─────────────────────────────────────────────
// TEST 21: Multi-source — select fields from projects
// ─────────────────────────────────────────────
async function testMultiSourceSelect() {
  console.log('\n── TEST: [Multi-Source] Select projectName, status from projects ──');
  const { status, body } = await sendMultiRequest(
    'select projectName, status from projects',
    [employeeSource, departmentSource, projectSource, clientSource]
  );

  assert('Status 200', status === 200, `got ${status}`);
  assert('Mode is dynamic_select', body.mode === 'dynamic_select', `mode: ${body.mode}`);

  const results = body.results?.[0]?.results || [];

  assert('Got 3 projects', results.length === 3, `got ${results.length}`);
  if (results.length > 0) {
    const keys = Object.keys(results[0]);
    assert('Only projectName and status', keys.length === 2 && keys.includes('projectName') && keys.includes('status'),
      `keys: ${JSON.stringify(keys)}`);
    assert('No projectId leaked',    !('projectId'    in results[0]), `projectId present`);
    assert('No clientId leaked',     !('clientId'     in results[0]), `clientId present`);
    assert('No assignedEmpId leaked',!('assignedEmpId' in results[0]), `assignedEmpId present`);
  }
}

// ─────────────────────────────────────────────
// TEST 22: Multi-source — filter active projects without clientId
// ─────────────────────────────────────────────
async function testMultiSourceFilterExclude() {
  console.log('\n── TEST: [Multi-Source] Filter projects where status is Active without clientId, assignedEmpId ──');
  const { status, body } = await sendMultiRequest(
    'filter projects where status is Active without clientId, assignedEmpId',
    [employeeSource, departmentSource, projectSource, clientSource]
  );

  assert('Status 200', status === 200, `got ${status}`);

  const results = body.results?.[0]?.results || [];

  assert('Found 2 Active projects', results.length === 2, `got ${results.length}`);
  if (results.length > 0) {
    const item = results[0].data || results[0];
    assert('clientId excluded',      !('clientId'      in item), `clientId present`);
    assert('assignedEmpId excluded', !('assignedEmpId' in item), `assignedEmpId present`);
    assert('projectName present',     'projectName'   in item,   `projectName missing`);
  }
}

// ─────────────────────────────────────────────
// TEST 23: Multi-source — multi-op across sources
// ─────────────────────────────────────────────
async function testMultiSourceMultiOp() {
  console.log('\n── TEST: [Multi-Source] Group employees by role and count projects by status ──');
  const { status, body } = await sendMultiRequest(
    'group employees by role and count projects by status',
    [employeeSource, departmentSource, projectSource, clientSource]
  );

  assert('Status 200', status === 200, `got ${status}`);

  if (body.mode === 'multi_operation') {
    assert('Has operations array', Array.isArray(body.operations), 'missing operations');
    assert('Has 2 operations', body.operations.length === 2, `got ${body.operations.length}`);

    const ops = body.operations.map(o => o.query?.operation);
    assert('First op is group', ops[0] === 'group', `got ${ops[0]}`);
    assert('Second op is count', ops[1] === 'count', `got ${ops[1]}`);
  } else {
    assert('At least one op executed', body.mode?.startsWith('dynamic_'), `mode: ${body.mode}`);
  }
}

// ─────────────────────────────────────────────
// RUN ALL TESTS
// ─────────────────────────────────────────────

async function runAll() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║        JSON Architect Agent — Full Test Suite                 ║');
  console.log('╠═══════════════════════════════════════════════════════════════╣');
  console.log('║  PART 1: Single-source deep nested queries (14 tests)         ║');
  console.log('║  PART 2: Multi-source queries (4 sources like UI) (9 tests)   ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');

  try {
    console.log('\n════════════ PART 1: Single Source (Deep Nested) ════════════');
    await testGroupBy();
    await testFilter();
    await testSortAsc();
    await testSortDesc();
    await testSelect();
    await testCount();
    await testUnique();
    await testGroupWithExclude();
    await testFilterWithExclude();
    await testDeepNesting();
    await testMultiOp();
    await testSortDepartments();
    await testUniqueDepts();
    await testSelectDeep();

    console.log('\n════════════ PART 2: Multi-Source (4 Sources) ════════════');
    await testMultiSourceFilterS1();
    await testMultiSourceFilterS2();
    await testMultiSourceGroupProjects();
    await testMultiSourceCount();
    await testMultiSourceUnique();
    await testMultiSourceSort();
    await testMultiSourceSelect();
    await testMultiSourceFilterExclude();
    await testMultiSourceMultiOp();
  } catch (err) {
    console.error('\n⛔ FATAL:', err.message);
  }

  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log(`║  RESULTS: ${passed} passed, ${failed} failed (${passed + failed} total)     `);
  console.log('╚═══════════════════════════════════════════════╝');

  if (failures.length > 0) {
    console.log('\nFailed assertions:');
    for (const f of failures)
      console.log(`  • ${f.testName}${f.detail ? ': ' + f.detail : ''}`);
  }

  console.log(`\nAccuracy: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
}

runAll();

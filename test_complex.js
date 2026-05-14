const jsonInputs = [
  { name: 'doc2.txt', content: JSON.stringify({ userProfile: { depth_1: { depth_2: { depth_3: { depth_4: { depth_5: { depth_6: { depth_7: { info: 'deep7' } } } } } } } } }) },
  { name: 'mohandemo.txt', content: JSON.stringify({ level_1: { level_2: { level_3: { level_4: { level_5: { data: 'level5' } } } } } }) },
  { name: 'doc3.txt', content: JSON.stringify({ node_1: { node_2: { node_3: { node_4: { node_5: { node_6: { node_7: { node_8: { node_9: { value: 'node9' } } } } } } } } } }) },
  { name: 'doc4.txt', content: JSON.stringify({ stage_1: { stage_2: { stage_3: { stage_4: { stage_5: { stage_6: { stage_7: { stage_8: { content: 'stage8' } } } } } } } } }) },
  { name: 'doc5.txt', content: JSON.stringify({ final: { result: 'done' } }) },
  { name: 'Source 1', content: JSON.stringify({ employees: [
    { employeeId: 'EMP_101', name: 'Mohan', departmentId: 'DEP_1', projectIds: ['PROJ_1', 'PROJ_2'], skills: ['Node.js', 'MongoDB', 'React'] },
    { employeeId: 'EMP_102', name: 'Raj', departmentId: 'DEP_1', projectIds: ['PROJ_2'], skills: ['Python', 'AI'] },
    { employeeId: 'EMP_104', name: 'Priya', departmentId: 'DEP_2', projectIds: ['PROJ_3'], skills: ['SEO', 'Marketing'] }
  ]}) }
];

const prompt = `@doc2.txt main object che.
depth_7 ni under @mohandemo.txt add karo.
@mohandemo.txt ni level_5 ni under @doc3.txt add karo.
@doc3.txt ni node_9 ni under @doc4.txt add karo.
@doc4.txt ni stage_8 ni under @doc5.txt add karo.
Pachi: grouped analytics object create karo and ema @Source 1 employees array no { employeeId, name, departmentId } aa rite array object muko`;

const formData = new URLSearchParams();
formData.append('jsonInputs', JSON.stringify(jsonInputs));
formData.append('prompt', prompt);

fetch('http://localhost:5000/api/convert', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: formData
}).then(async r => {
  const text = await r.text();
  console.log('Status:', r.status);
  if (r.status !== 200) {
    console.log('Error:', text.slice(0, 500));
    return;
  }
  try {
    const json = JSON.parse(text);
    console.log(JSON.stringify(json, null, 2));
  } catch (e) {
    console.error('Not JSON:', text.slice(0, 200));
  }
}).catch(e => console.error(e));

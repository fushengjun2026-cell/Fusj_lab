const gameBoard=document.querySelector("#game-2048-board");
const scoreValue=document.querySelector("#score-value");
const bestValue=document.querySelector("#best-value");
const gameMessage=document.querySelector("#game-2048-message");
const undoButton=document.querySelector("#undo-2048");
const undoCount=document.querySelector("#undo-count");
const resetGameButton=document.querySelector("#reset-2048");
const size=4;
let grid=[];
let score=0;
let best=Number(localStorage.getItem("cosmic-2048-best")||0);
let history=[];
let gameOver=false;
let touchStart=null;

function emptyGrid(){return Array.from({length:size},()=>Array(size).fill(0))}
function copyGrid(source){return source.map(row=>row.slice())}
function addTile(){const empty=[];for(let row=0;row<size;row++)for(let col=0;col<size;col++)if(grid[row][col]===0)empty.push([row,col]);if(!empty.length)return;const [row,col]=empty[Math.floor(Math.random()*empty.length)];grid[row][col]=Math.random()<.9?2:4}
function snapshot(){return {grid:copyGrid(grid),score}}
function restore(state){grid=copyGrid(state.grid);score=state.score;gameOver=false;draw()}
function compress(line){const values=line.filter(Boolean),result=[];let gained=0;for(let index=0;index<values.length;index++){if(values[index]===values[index+1]){const merged=values[index]*2;result.push(merged);gained+=merged;index++}else result.push(values[index])}while(result.length<size)result.push(0);return {line:result,gained}}
function move(direction){if(gameOver)return;const before=copyGrid(grid),beforeScore=score;let gained=0;for(let index=0;index<size;index++){let line=[];for(let offset=0;offset<size;offset++){const row=direction==="up"?offset:direction==="down"?size-1-offset:index;const col=direction==="left"?offset:direction==="right"?size-1-offset:index;line.push(grid[row][col])}const compressed=compress(line);gained+=compressed.gained;for(let offset=0;offset<size;offset++){const row=direction==="up"?offset:direction==="down"?size-1-offset:index;const col=direction==="left"?offset:direction==="right"?size-1-offset:index;grid[row][col]=compressed.line[offset]}}const changed=grid.some((row,rowIndex)=>row.some((value,colIndex)=>value!==before[rowIndex][colIndex]));if(!changed){setMessage(gameOver?"The board is full. Undo a move to continue.":"No signal moved in that direction.");return}history.push({grid:before,score:beforeScore});score+=gained;if(score>best){best=score;localStorage.setItem("cosmic-2048-best",String(best))}addTile();draw();if(!hasMoves())gameOver=true;setMessage(gameOver?"The board is full. Undo a move to continue.":gained?`Merged signal +${gained}.`:"Signal shifted.")}
function hasMoves(){if(grid.some(row=>row.includes(0)))return true;for(let row=0;row<size;row++)for(let col=0;col<size;col++){if(row<size-1&&grid[row][col]===grid[row+1][col])return true;if(col<size-1&&grid[row][col]===grid[row][col+1])return true}return false}
function setMessage(message){if(gameMessage)gameMessage.textContent=message}
function draw(){if(!gameBoard)return;gameBoard.innerHTML="";for(let row=0;row<size;row++)for(let col=0;col<size;col++){const value=grid[row][col];const tile=document.createElement("div");tile.className=`game-2048-tile ${value?`tile-${value}`:"tile-empty"}`;tile.setAttribute("aria-label",value?`Tile ${value}`:"Empty tile");if(value)tile.textContent=value;gameBoard.append(tile)}if(scoreValue)scoreValue.textContent=score;if(bestValue)bestValue.textContent=best;if(undoCount)undoCount.textContent=history.length;if(undoButton)undoButton.disabled=!history.length}
function undo(){if(!history.length){setMessage("Nothing to undo yet.");return}const previous=history.pop();restore(previous);setMessage("Move restored. Choose another orbit.")}
function newGame(){grid=emptyGrid();score=0;history=[];gameOver=false;addTile();addTile();draw();setMessage("Use the arrow keys, buttons, or swipe to begin.")}
function handleDirection(direction){move(direction)}
document.querySelectorAll("[data-move]").forEach(button=>button.addEventListener("click",()=>handleDirection(button.dataset.move)));
undoButton?.addEventListener("click",undo);resetGameButton?.addEventListener("click",newGame);
addEventListener("keydown",event=>{const keys={ArrowUp:"up",ArrowDown:"down",ArrowLeft:"left",ArrowRight:"right",w:"up",s:"down",a:"left",d:"right"};if(event.key==="Escape"){undo();return}if(keys[event.key]){event.preventDefault();handleDirection(keys[event.key])}});
gameBoard?.addEventListener("touchstart",event=>{const touch=event.changedTouches[0];touchStart=[touch.clientX,touch.clientY]},{passive:true});
gameBoard?.addEventListener("touchend",event=>{if(!touchStart)return;const touch=event.changedTouches[0],dx=touch.clientX-touchStart[0],dy=touch.clientY-touchStart[1];touchStart=null;if(Math.max(Math.abs(dx),Math.abs(dy))<28)return;handleDirection(Math.abs(dx)>Math.abs(dy)?dx>0?"right":"left":dy>0?"down":"up")},{passive:true});
newGame();

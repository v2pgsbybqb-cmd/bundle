const users=document.getElementById("usersOnline")
const speed=document.getElementById("networkSpeed")
const sold=document.getElementById("bundlesSold")
const load=document.getElementById("networkLoad")

let bundles=1200

setInterval(()=>{
users.innerText="Users Online: "+(Math.floor(Math.random()*40)+20)
},2000)

setInterval(()=>{
speed.innerText="Network Speed: "+(Math.floor(Math.random()*100)+20)+" Mbps"
},2000)

setInterval(()=>{
bundles+=Math.floor(Math.random()*3)
sold.innerText="Bundles Today: "+bundles
},3000)

setInterval(()=>{
const percent=Math.floor(Math.random()*40)+60
load.innerText="Network Load: "+percent+"%"
},2000)



/* FAKE PURCHASES */

const names=["John","Asha","Kelvin","Maria","Ali","Fatma"]
const cities=["Dar","Arusha","Mwanza","Dodoma"]

function purchase(){

const name=names[Math.floor(Math.random()*names.length)]
const city=cities[Math.floor(Math.random()*cities.length)]

const box=document.createElement("div")

box.innerText=`🟢 ${name} from ${city} purchased 7GB`

box.style.position="fixed"
box.style.bottom="20px"
box.style.left="20px"
box.style.background="#111"
box.style.padding="10px"
box.style.borderRadius="10px"

document.body.appendChild(box)

setTimeout(()=>box.remove(),4000)

}

setInterval(purchase,5000)